require("dotenv").config();
const express = require("express");
const axios = require("axios");
const OpenAI = require("openai");
const Redis = require("ioredis");

const app = express();
app.use(express.json());

const {
    WHATSAPP_TOKEN,
    WHATSAPP_PHONE_ID,
    OPENAI_API_KEY,
    VERIFY_TOKEN,
    PORT,
    OPENAI_ORGANIZATION,
    OPENAI_PROJECT,
    REDIS_URL,
    ASSISTANT_ID,
    WHATSAPP_MAX_MESSAGE_LENGTH: WHATSAPP_MAX_MESSAGE_LENGTH_ENV, // Renomeado para evitar conflito com constante antiga
    WELCOME_MESSAGE_1: ENV_WELCOME_MESSAGE_1,
    WELCOME_MESSAGE_2: ENV_WELCOME_MESSAGE_2,
    PROCESSING_MESSAGE: ENV_PROCESSING_MESSAGE
} = process.env;

// --- Constants ---
const THREAD_EXPIRY_SECONDS = 12 * 60 * 60; // 12 hours
const THREAD_EXPIRY_MILLISECONDS = THREAD_EXPIRY_SECONDS * 1000;
const WHATSAPP_MAX_MESSAGE_LENGTH = parseInt(WHATSAPP_MAX_MESSAGE_LENGTH_ENV) || 4000;
const POLLING_TIMEOUT_MS = 60000; // Max time to wait for Assistant run (60 seconds)
const POLLING_INTERVAL_MS = 1500; // Interval between polling checks (1.5 seconds)

const WELCOME_MESSAGE_1 = ENV_WELCOME_MESSAGE_1 || "Olá! Sou seu assistente virtual. Estou aqui para ajudar com suas dúvidas e solicitações.";
const WELCOME_MESSAGE_2 = ENV_WELCOME_MESSAGE_2 || "Para começar, por favor, descreva sua dúvida ou o que você precisa.";
const PROCESSING_MESSAGE = ENV_PROCESSING_MESSAGE || "Estou processando sua solicitação, aguarde um momento...";

// User States for Redis
const USER_STATE_AWAITING_INITIAL_PROMPT = "AWAITING_INITIAL_PROMPT";
const USER_STATE_CONVERSING = "CONVERSING";

// --- Input Validation ---
if (!REDIS_URL) {
    console.error("FATAL: Missing REDIS_URL environment variable.");
    process.exit(1);
}
if (!ASSISTANT_ID) {
    console.error("FATAL: Missing ASSISTANT_ID environment variable.");
    process.exit(1);
}
if (!WHATSAPP_TOKEN || !WHATSAPP_PHONE_ID || !OPENAI_API_KEY || !VERIFY_TOKEN) {
    console.error("FATAL: Missing one or more required environment variables (WhatsApp/OpenAI/Verify tokens).");
    process.exit(1);
}
if (!WHATSAPP_MAX_MESSAGE_LENGTH_ENV) {
    console.warn("WARN: Missing WHATSAPP_MAX_MESSAGE_LENGTH environment variable. Using default 4000.");
}


// --- Configure Redis Client ---
const redis = new Redis(REDIS_URL, {
    maxRetriesPerRequest: 3,
    // Enable TLS if required by your provider (like Vercel KV)
    // tls: { rejectUnauthorized: false } 
});

redis.on("connect", () => console.log("Redis connected successfully!"));
redis.on("error", (err) => console.error("Redis connection error:", err));

// --- Configure OpenAI Client ---
const openai = new OpenAI({
    apiKey: OPENAI_API_KEY,
    organization: OPENAI_ORGANIZATION, // Optional
    project: OPENAI_PROJECT,         // Optional
});

// --- Webhook Verification --- 
app.get("/webhook", (req, res) => {
    const mode = req.query["hub.mode"];
    const token = req.query["hub.verify_token"];
    const challenge = req.query["hub.challenge"];

    if (mode && token && mode === "subscribe" && token === VERIFY_TOKEN) {
        console.log("Webhook verified successfully!");
        res.status(200).send(challenge);
    } else {
        console.warn("Webhook verification failed.", { mode, token });
        res.sendStatus(403);
    }
});

// --- Handle Incoming Messages --- 
app.post("/webhook", async (req, res) => {
    const body = req.body;

    if (body.object !== "whatsapp_business_account") {
        res.sendStatus(404); // Not a WhatsApp event we process
        return;
    }

    const messageEntry = body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];

    if (!messageEntry) {
        console.log("Received WhatsApp notification without a message entry, ignoring.");
        res.sendStatus(200); // Acknowledge, but nothing to process
        return;
    }

    const from = messageEntry.from;
    const messageType = messageEntry.type;
    const userStateKey = `whatsapp_user_status:${from}`;
    const userThreadDataKey = `whatsapp_thread_data:${from}`;

    console.log(`[${from}] Received incoming notification. Type: ${messageType}`);
    res.sendStatus(200); // Acknowledge receipt immediately to WhatsApp

    try {
        let userState = await redis.get(userStateKey);

        // Handle 'request_welcome' or first text message from a new/reset user
        if (messageType === "request_welcome" || (messageType === "text" && !userState)) {
            console.log(`[${from}] Initiating welcome flow. Current state: ${userState}, Message Type: ${messageType}`);
            await sendWhatsappMessage(from, WELCOME_MESSAGE_1);
            await sendWhatsappMessage(from, WELCOME_MESSAGE_2);
            await redis.set(userStateKey, USER_STATE_AWAITING_INITIAL_PROMPT, "EX", THREAD_EXPIRY_SECONDS * 2);
            return; // End processing for this request, wait for user's actual prompt
        }

        if (messageType === "text") {
            const msg_body = messageEntry.text.body;
            console.log(`[${from}] Received text message: "${msg_body.substring(0,50)}..." Current state: ${userState}`);

            if (userState === USER_STATE_AWAITING_INITIAL_PROMPT || userState === USER_STATE_CONVERSING || !userState) {
                // If !userState here, it implies request_welcome wasn't hit, but it's a text from a potentially known user or a user who missed welcome.
                // We can transition them to conversing. If it's truly their first prompt, the thread creation will handle it.
                if (userState === USER_STATE_AWAITING_INITIAL_PROMPT) {
                     console.log(`[${from}] Received initial prompt after welcome.`);
                }
                await sendWhatsappMessage(from, PROCESSING_MESSAGE);
                await redis.set(userStateKey, USER_STATE_CONVERSING, "EX", THREAD_EXPIRY_SECONDS * 2);

                // Proceed with OpenAI Assistant logic
                let threadId = await getOrCreateThread(from, userThreadDataKey, userStateKey); // Pass userStateKey to potentially reset if thread is new
                if (!threadId) return; // Error handled within getOrCreateThread

                await openai.beta.threads.messages.create(threadId, {
                    role: "user",
                    content: msg_body,
                });
                console.log(`[${from}] Added message to thread ${threadId}`);

                const run = await openai.beta.threads.runs.create(threadId, {
                    assistant_id: ASSISTANT_ID,
                });
                console.log(`[${from}] Created run ${run.id} for thread ${threadId}`);

                const finalRunStatus = await pollRunStatus(threadId, run.id, from);
                await processRunResult(finalRunStatus, threadId, run.id, from);
            } else {
                console.warn(`[${from}] Received text message in an unexpected state: ${userState}. Ignoring.`);
                // Optionally, send a message like "I'm not sure how to handle that right now."
            }
        } else {
            console.log(`[${from}] Received non-text message type: ${messageType}, ignoring for main processing.`);
            // If other message types (image, audio) need handling, add logic here.
        }
    } catch (error) {
        console.error(`[${from}] Unhandled error in main webhook processing:`, error);
        await handleGenericError(from);
    }
});

// --- Helper Functions ---

async function getOrCreateThread(from, userThreadDataKey, userStateKey) {
    let threadId = null;
    let createNewThread = false;
    const now = Date.now();

    try {
        const threadDataString = await redis.get(userThreadDataKey);
        if (threadDataString) {
            const threadData = JSON.parse(threadDataString);
            if (threadData.threadId && threadData.lastInteractionTimestamp) {
                if (now - threadData.lastInteractionTimestamp > THREAD_EXPIRY_MILLISECONDS) {
                    console.log(`[${from}] Thread expired. Creating new thread.`);
                    createNewThread = true;
                } else {
                    threadId = threadData.threadId;
                    console.log(`[${from}] Using existing thread ${threadId}.`);
                }
            } else {
                console.warn(`[${from}] Invalid thread data found. Creating new thread.`);
                createNewThread = true;
            }
        } else {
            console.log(`[${from}] No thread data found. Creating new thread.`);
            createNewThread = true;
        }
    } catch (error) {
        console.error(`[${from}] Redis GET error for ${userThreadDataKey}:`, error);
        await handleGenericError(from, "Error accessing conversation state.");
        return null;
    }

    if (createNewThread) {
        try {
            const thread = await openai.beta.threads.create();
            threadId = thread.id;
            console.log(`[${from}] Created new thread ${threadId}`);
            // If a new thread is created, it implies a new conversation session.
            // Reset user state to ensure welcome messages are sent if they interact again after a long break (handled by main webhook logic).
            // However, if getOrCreateThread is called *after* welcome, this might be redundant or slightly off.
            // For now, the welcome logic is primarily at the start of the webhook.
            // Consider if userStateKey needs reset here. If thread expired, user state might also be stale.
            // The main webhook logic should re-trigger welcome if userState is not AWAITING_INITIAL_PROMPT or CONVERSING.
        } catch (error) {
            console.error(`[${from}] OpenAI thread creation error:`, error);
            await handleOpenAIError(error, from);
            return null;
        }
    }

    try {
        const newThreadData = JSON.stringify({ 
            threadId: threadId, 
            lastInteractionTimestamp: now 
        });
        await redis.set(userThreadDataKey, newThreadData, "EX", THREAD_EXPIRY_SECONDS * 2); 
    } catch (error) {
        console.error(`[${from}] Redis SET error for ${userThreadDataKey}:`, error);
    }

    return threadId;
}

async function pollRunStatus(threadId, runId, from) {
    const startTime = Date.now();
    try {
        while (Date.now() - startTime < POLLING_TIMEOUT_MS) {
            const currentRun = await openai.beta.threads.runs.retrieve(threadId, runId);
            const status = currentRun.status;
            console.log(`[${from}] Run ${runId} status: ${status}`);

            if (!["queued", "in_progress", "cancelling"].includes(status)) {
                return status;
            }
            await new Promise(resolve => setTimeout(resolve, POLLING_INTERVAL_MS));
        }
        console.warn(`[${from}] Run ${runId} polling timed out after ${POLLING_TIMEOUT_MS}ms.`);
        await sendWhatsappMessage(from, "A IA está demorando muito para responder. Por favor, tente novamente em alguns instantes.");
        return "timed_out";
    } catch (error) {
        console.error(`[${from}] Error polling run ${runId} status:`, error);
        await handleOpenAIError(error, from);
        return "polling_error";
    }
}

async function processRunResult(finalRunStatus, threadId, runId, from) {
    try {
        if (finalRunStatus === "completed") {
            console.log(`[${from}] Run ${runId} completed. Fetching messages.`);
            const messages = await openai.beta.threads.messages.list(threadId, { order: 'desc', limit: 10 });
            const assistantMessages = messages.data.filter(m => m.run_id === runId && m.role === 'assistant');
            
            if (assistantMessages.length > 0) {
                for (const assistantMessage of assistantMessages.reverse()) {
                    if (assistantMessage.content[0]?.type === 'text') {
                        const responseText = assistantMessage.content[0].text.value;
                        if (responseText) {
                            console.log(`[${from}] Assistant response: ${responseText.substring(0, 100)}...`);
                            await sendWhatsappMessage(from, responseText);
                        } else {
                             console.warn(`[${from}] Assistant message content is empty for run ${runId}.`);
                        }
                    }
                }
            } else {
                console.warn(`[${from}] No new assistant messages found for completed run ${runId}.`);
                await sendWhatsappMessage(from, "Não consegui gerar uma resposta para sua solicitação no momento. Tente reformular sua pergunta.");
            }
        } else if (finalRunStatus === "requires_action") {
            console.error(`[${from}] Run ${runId} requires action (Function Calling not implemented).`);
            await sendWhatsappMessage(from, "Preciso de realizar uma ação que ainda não sei fazer. Por favor, contacte o suporte.");
        } else if (finalRunStatus !== "timed_out" && finalRunStatus !== "polling_error") { // Avoid double messaging for timeout/polling handled in pollRunStatus
            console.error(`[${from}] Run ${runId} ended with status: ${finalRunStatus}`);
            await sendWhatsappMessage(from, "Lamento, ocorreu um problema ao processar o seu pedido com a IA. Tente novamente.");
        }
    } catch (error) {
        console.error(`[${from}] Error processing run ${runId} result:`, error);
        await handleOpenAIError(error, from);
    }
}

async function sendWhatsappMessage(to, text) {
    if (!text || String(text).trim() === "") {
        console.warn(`[${to}] Attempted to send empty message. Aborting.`);
        return;
    }
    const messageChunks = [];
    for (let i = 0; i < text.length; i += WHATSAPP_MAX_MESSAGE_LENGTH) {
        messageChunks.push(text.substring(i, i + WHATSAPP_MAX_MESSAGE_LENGTH));
    }

    console.log(`[${to}] Sending ${messageChunks.length} message chunk(s).`);

    for (let i = 0; i < messageChunks.length; i++) {
        const chunk = messageChunks[i];
        const url = `https://graph.facebook.com/v19.0/${WHATSAPP_PHONE_ID}/messages`;
        const data = {
            messaging_product: "whatsapp",
            to: to,
            type: "text",
            text: { body: chunk },
        };
        const headers = {
            "Authorization": `Bearer ${WHATSAPP_TOKEN}`,
            "Content-Type": "application/json",
        };

        try {
            console.log(`[${to}] Sending chunk ${i + 1}/${messageChunks.length}: ${chunk.substring(0, 50)}...`);
            await axios.post(url, data, { headers });
            console.log(`[${to}] Chunk ${i + 1} sent successfully.`);
        } catch (error) {
            console.error(`[${to}] Error sending WhatsApp message chunk ${i + 1}:`, 
                error.response ? `Status ${error.response.status} - ${JSON.stringify(error.response.data)}` : error.message
            );
            if (error.response?.status === 429) {
                 console.warn(`[${to}] WhatsApp API rate limit hit. Consider adding delays or handling this more gracefully.`);
            }
        }
    }
}

async function handleOpenAIError(error, recipient) {
    let userMessage = "Lamento, ocorreu um problema ao comunicar com a IA. Por favor, tente novamente mais tarde.";
    if (error.response) {
        console.error(`[${recipient}] OpenAI API Error: Status ${error.response.status}`, error.response.data);
        if (error.response.status === 429) {
            userMessage = "Estou a receber muitos pedidos neste momento. Por favor, aguarde um pouco e tente novamente.";
        }
    } else {
        console.error(`[${recipient}] OpenAI SDK/Network Error:`, error.message);
    }
    await sendWhatsappMessage(recipient, userMessage);
}

async function handleGenericError(recipient, specificMessage = null) {
    const userMessage = specificMessage || "Lamento, ocorreu um erro interno inesperado. Por favor, tente novamente mais tarde.";
    await sendWhatsappMessage(recipient, userMessage);
}

if (process.env.NODE_ENV !== "production") {
    const port = PORT || 3000;
    app.listen(port, () => {
        console.log(`Webhook listener started locally on port ${port}`);
    });
}

module.exports = app;


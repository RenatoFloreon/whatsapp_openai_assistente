console.log('[INDEX_JS_TOP_LEVEL] Script execution started at ' + new Date().toISOString()); // <--- ADICIONE ESTA LINHA NO TOPO
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
    WHATSAPP_MAX_MESSAGE_LENGTH: WHATSAPP_MAX_MESSAGE_LENGTH_ENV,
    WELCOME_MESSAGE_1: ENV_WELCOME_MESSAGE_1,
    WELCOME_MESSAGE_2: ENV_WELCOME_MESSAGE_2,
    PROCESSING_MESSAGE: ENV_PROCESSING_MESSAGE
} = process.env;

// --- Constants ---
const THREAD_EXPIRY_SECONDS = 12 * 60 * 60; // 12 hours
const THREAD_EXPIRY_MILLISECONDS = THREAD_EXPIRY_SECONDS * 1000;
const WHATSAPP_MAX_MESSAGE_LENGTH = parseInt(WHATSAPP_MAX_MESSAGE_LENGTH_ENV) || 4000;
const POLLING_TIMEOUT_MS = 60000; // Max time to wait for Assistant run (60 seconds)
const POLLING_INTERVAL_MS = 2000; // Interval between polling checks (2 seconds) - increased slightly

const WELCOME_MESSAGE_1 = ENV_WELCOME_MESSAGE_1 || "Olá! Você está conversando com uma Inteligência Artificial experimental, e, portanto, podem acontecer erros.";
const WELCOME_MESSAGE_2 = ENV_WELCOME_MESSAGE_2 || "Fique tranquilo(a) que seus dados estão protegidos, pois só consigo manter a memória da nossa conversa por 12 horas, depois o chat é reiniciado e os dados, apagados.";
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

redis.on("connect", () => console.log("[REDIS] Conectado com sucesso!"));
redis.on("error", (err) => console.error("[REDIS] Erro de conexão:", err));

// --- Configure OpenAI Client ---
const openai = new OpenAI({
    apiKey: OPENAI_API_KEY,
    organization: OPENAI_ORGANIZATION, // Optional
    project: OPENAI_PROJECT,         // Optional
});

// --- Webhook Verification --- 
app.get('/webhook', (req, res) => {
    console.log('[WEBHOOK_ENTRY] GET request received on /webhook'); // <--- ADICIONE ESTA LINHA
    const mode = req.query["hub.mode"];
    const token = req.query["hub.verify_token"];
    const challenge = req.query["hub.challenge"];

    if (mode && token && mode === "subscribe" && token === VERIFY_TOKEN) {
        console.log("[WEBHOOK_VERIFICATION] Webhook verificado com sucesso!");
        res.status(200).send(challenge);
    } else {
        console.warn("[WEBHOOK_VERIFICATION] Falha na verificação do webhook.", { mode, token });
        res.sendStatus(403);
    }
});

// --- Handle Incoming Messages --- 
app.post('/webhook', async (req, res) => {
        console.log('[WEBHOOK_ENTRY] POST request received on /webhook'); // <--- ADICIONE ESTA LINHA
    
    const body = req.body;

    if (body.object !== "whatsapp_business_account") {
        res.sendStatus(404); 
        return;
    }

    const messageEntry = body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];

    if (!messageEntry) {
        console.log("[WEBHOOK] Recebeu notificação do WhatsApp sem uma entrada de mensagem, ignorando.");
        res.sendStatus(200); 
        return;
    }

    const from = messageEntry.from;
    const messageType = messageEntry.type;
    const userStateKey = `whatsapp_user_status:${from}`;
    const userThreadDataKey = `whatsapp_thread_data:${from}`;

    console.log(`[WEBHOOK] [${from}] Notificação recebida. Tipo: ${messageType}`);
    res.sendStatus(200); // Acknowledge receipt immediately to WhatsApp

    try {
        let userState = await redis.get(userStateKey);
        console.log(`[REDIS] [${from}] Estado atual do usuário: ${userState}`);

        if (messageType === "request_welcome" || (messageType === "text" && !userState)) {
            console.log(`[WEBHOOK] [${from}] Iniciando fluxo de boas-vindas. Estado anterior: ${userState}, Tipo de Mensagem: ${messageType}`);
            await sendWhatsappMessage(from, WELCOME_MESSAGE_1);
            await sendWhatsappMessage(from, WELCOME_MESSAGE_2);
            await redis.set(userStateKey, USER_STATE_AWAITING_INITIAL_PROMPT, "EX", THREAD_EXPIRY_SECONDS * 2);
            console.log(`[REDIS] [${from}] Estado do usuário definido para AWAITING_INITIAL_PROMPT.`);
            return; 
        }

        if (messageType === "text") {
            const msg_body = messageEntry.text.body;
            console.log(`[WEBHOOK] [${from}] Mensagem de texto recebida: "${msg_body.substring(0,50)}..." Estado atual: ${userState}`);

            if (userState === USER_STATE_AWAITING_INITIAL_PROMPT || userState === USER_STATE_CONVERSING) {
                if (userState === USER_STATE_AWAITING_INITIAL_PROMPT) {
                     console.log(`[WEBHOOK] [${from}] Recebeu o prompt inicial após as boas-vindas.`);
                }
                await sendWhatsappMessage(from, PROCESSING_MESSAGE);
                await redis.set(userStateKey, USER_STATE_CONVERSING, "EX", THREAD_EXPIRY_SECONDS * 2);
                console.log(`[REDIS] [${from}] Estado do usuário definido para CONVERSING.`);

                let threadId = await getOrCreateThread(from, userThreadDataKey);
                if (!threadId) return; 

                const aiResponse = await handleOpenAICalls(msg_body, threadId, ASSISTANT_ID, from);
                if (aiResponse) {
                    await sendWhatsappMessage(from, aiResponse);
                } else {
                    console.warn(`[WEBHOOK] [${from}] handleOpenAICalls retornou uma resposta vazia ou indefinida. Nenhuma mensagem enviada para o usuário.`);
                    // Consider sending a generic error if this state is unexpected
                    // await sendWhatsappMessage(from, "Não consegui processar sua solicitação no momento.");
                }
            } else {
                console.warn(`[WEBHOOK] [${from}] Mensagem de texto recebida em um estado inesperado: ${userState}. Ignorando.`);
            }
        } else {
            console.log(`[WEBHOOK] [${from}] Tipo de mensagem não textual recebido: ${messageType}, ignorando para processamento principal.`);
        }
    } catch (error) {
        console.error(`[WEBHOOK] [${from}] Erro não tratado no processamento principal do webhook:`, error.message, error.stack);
        await handleGenericError(from);
    }
});

// --- Helper Functions ---

async function getOrCreateThread(from, userThreadDataKey) {
    let threadId = null;
    let createNewThread = false;
    const now = Date.now();

    try {
        const threadDataString = await redis.get(userThreadDataKey);
        if (threadDataString) {
            const threadData = JSON.parse(threadDataString);
            if (threadData.threadId && threadData.lastInteractionTimestamp) {
                if (now - threadData.lastInteractionTimestamp > THREAD_EXPIRY_MILLISECONDS) {
                    console.log(`[REDIS] [${from}] Tópico expirado. Criando novo tópico.`);
                    createNewThread = true;
                } else {
                    threadId = threadData.threadId;
                    console.log(`[REDIS] [${from}] Usando tópico existente ${threadId}.`);
                }
            } else {
                console.warn(`[REDIS] [${from}] Dados de tópico inválidos encontrados. Criando novo tópico.`);
                createNewThread = true;
            }
        } else {
            console.log(`[REDIS] [${from}] Nenhum dado de tópico encontrado. Criando novo tópico.`);
            createNewThread = true;
        }
    } catch (error) {
        console.error(`[REDIS] [${from}] Erro ao obter dados do tópico ${userThreadDataKey}:`, error);
        await handleGenericError(from, "Erro ao acessar o estado da conversa.");
        return null;
    }

    if (createNewThread) {
        try {
            const thread = await openai.beta.threads.create();
            threadId = thread.id;
            console.log(`[OPENAI] [${from}] Novo tópico criado: ${threadId}`);
        } catch (error) {
            console.error(`[OPENAI] [${from}] Erro na criação do tópico OpenAI:`, error);
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
        console.log(`[REDIS] [${from}] Dados do tópico ${threadId} atualizados/salvos.`);
    } catch (error) {
        console.error(`[REDIS] [${from}] Erro ao salvar dados do tópico ${userThreadDataKey}:`, error);
        // Non-critical for immediate flow, but log it.
    }
    return threadId;
}

async function handleOpenAICalls(text, threadId, assistantId, from) {
    console.log(`[OPENAI] [${from}] Iniciando handleOpenAICalls. Thread: ${threadId}, Assistant: ${assistantId}, Mensagem: "${text.substring(0, 100)}"...`);
    try {
        console.log(`[OPENAI] [${from}] [Thread: ${threadId}] Adicionando mensagem do usuário ao tópico...`);
        await openai.beta.threads.messages.create(threadId, { role: "user", content: text });
        console.log(`[OPENAI] [${from}] [Thread: ${threadId}] Mensagem do usuário adicionada com sucesso.`);

        console.log(`[OPENAI] [${from}] [Thread: ${threadId}] Criando execução (run) com o assistente ${assistantId}...`);
        const run = await openai.beta.threads.runs.create(threadId, { assistant_id: assistantId });
        console.log(`[OPENAI] [${from}] [Thread: ${threadId}] Execução (run) criada com ID: ${run.id}. Status inicial: ${run.status}`);

        let runStatus = run.status;
        const startTime = Date.now();

        while (runStatus === "queued" || runStatus === "in_progress" || runStatus === "requires_action") {
            if (Date.now() - startTime > POLLING_TIMEOUT_MS) {
                console.error(`[OPENAI] [${from}] [Thread: ${threadId}] Timeout ao aguardar conclusão da execução ${run.id}. Último status: ${runStatus}`);
                return "Desculpe, a solicitação demorou muito para ser processada.";
            }
            await new Promise(resolve => setTimeout(resolve, POLLING_INTERVAL_MS));
            const currentRun = await openai.beta.threads.runs.retrieve(threadId, run.id);
            runStatus = currentRun.status;
            console.log(`[OPENAI] [${from}] [Thread: ${threadId}] Status da execução ${run.id}: ${runStatus}`);
        }

        if (runStatus === "completed") {
            console.log(`[OPENAI] [${from}] [Thread: ${threadId}] Execução ${run.id} completada. Buscando mensagens...`);
            const allMessages = await openai.beta.threads.messages.list(threadId, { order: "desc", limit: 20 });
            
            const assistantMessageFromRun = allMessages.data.find(
                (msg) => msg.role === "assistant" && msg.run_id === run.id && msg.content[0]?.type === "text"
            );

            if (assistantMessageFromRun) {
                const aiMessageContent = assistantMessageFromRun.content[0].text.value;
                console.log(`[OPENAI] [${from}] [Thread: ${threadId}] Conteúdo da mensagem da IA recebido: "${aiMessageContent.substring(0, 100)}"...`);
                return aiMessageContent;
            } else {
                console.error(`[OPENAI] [${from}] [Thread: ${threadId}] Nenhuma mensagem de texto da IA encontrada para a execução ${run.id}. Detalhes das mensagens recuperadas:`, JSON.stringify(allMessages.data.slice(0,5), null, 2)); // Log first 5 messages for brevity
                return "Não consegui obter uma resposta formatada corretamente da IA desta vez.";
            }
        } else if (runStatus === "requires_action") {
             console.error(`[OPENAI] [${from}] [Thread: ${threadId}] Execução ${run.id} requer ação (Function Calling não implementado).`);
             return "Preciso de realizar uma ação que ainda não sei fazer. Por favor, contacte o suporte.";
        } else {
            console.error(`[OPENAI] [${from}] [Thread: ${threadId}] Execução ${run.id} finalizada com status inesperado: ${runStatus}`);
            return `Desculpe, houve um problema com a IA (status: ${runStatus}).`;
        }
    } catch (error) {
        console.error(`[OPENAI] [${from}] [Thread: ${threadId}] Erro durante chamada à API OpenAI:`, error.message, error.stack);
        if (error.response && error.response.data) {
            console.error(`[OPENAI] [${from}] Detalhes do erro da API OpenAI:`, JSON.stringify(error.response.data, null, 2));
        }
        return "Desculpe, ocorreu um erro ao conectar com a IA. Tente novamente.";
    }
}

async function sendWhatsappMessage(to, text) {
    if (!text || String(text).trim() === "") {
        console.warn(`[WHATSAPP_SEND] [${to}] Tentativa de enviar mensagem vazia. Abortando.`);
        return;
    }
    const messageChunks = [];
    for (let i = 0; i < text.length; i += WHATSAPP_MAX_MESSAGE_LENGTH) {
        messageChunks.push(text.substring(i, i + WHATSAPP_MAX_MESSAGE_LENGTH));
    }

    console.log(`[WHATSAPP_SEND] [${to}] Enviando ${messageChunks.length} bloco(s) de mensagem.`);

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
            console.log(`[WHATSAPP_SEND] [${to}] Enviando bloco ${i + 1}/${messageChunks.length}: ${chunk.substring(0, 50)}...`);
            await axios.post(url, data, { headers });
            console.log(`[WHATSAPP_SEND] [${to}] Bloco ${i + 1} enviado com sucesso.`);
        } catch (error) {
            console.error(`[WHATSAPP_SEND] [${to}] Erro ao enviar bloco de mensagem ${i + 1}:`, 
                error.response ? `Status ${error.response.status} - ${JSON.stringify(error.response.data)}` : error.message
            );
            if (error.response?.status === 429) {
                 console.warn(`[WHATSAPP_SEND] [${to}] Limite de taxa da API do WhatsApp atingido. Considere adicionar atrasos ou tratar isso com mais robustez.`);
            }
            // Do not re-throw here to allow other chunks to be sent if possible, or to avoid breaking the main flow.
            // The error is logged.
        }
    }
}

async function handleOpenAIError(error, recipient) {
    let userMessage = "Lamento, ocorreu um problema ao comunicar com a IA. Por favor, tente novamente mais tarde.";
    if (error.response) {
        console.error(`[OPENAI_ERROR_HANDLER] [${recipient}] Erro da API OpenAI: Status ${error.response.status}`, error.response.data);
        if (error.response.status === 429) {
            userMessage = "Estou a receber muitos pedidos neste momento. Por favor, aguarde um pouco e tente novamente.";
        }
    } else {
        console.error(`[OPENAI_ERROR_HANDLER] [${recipient}] Erro de SDK/Rede OpenAI:`, error.message);
    }
    await sendWhatsappMessage(recipient, userMessage);
}

async function handleGenericError(recipient, specificMessage = null) {
    const userMessage = specificMessage || "Lamento, ocorreu um erro interno inesperado. Por favor, tente novamente mais tarde.";
    console.log(`[GENERIC_ERROR_HANDLER] [${recipient}] Enviando mensagem de erro genérico: "${userMessage}"`);
    await sendWhatsappMessage(recipient, userMessage);
}

// --- Start Server ---
const serverPort = PORT || 3000;
app.listen(serverPort, () => {
    console.log(`Servidor rodando na porta ${serverPort}`);
    console.log("Variáveis de ambiente carregadas:");
    console.log(`- ASSISTANT_ID: ${ASSISTANT_ID ? 'Carregado' : 'AUSENTE!'}`);
    console.log(`- REDIS_URL: ${REDIS_URL ? 'Carregado' : 'AUSENTE!'}`);
    console.log(`- WHATSAPP_TOKEN: ${WHATSAPP_TOKEN ? 'Carregado' : 'AUSENTE!'}`);
    console.log(`- WHATSAPP_PHONE_ID: ${WHATSAPP_PHONE_ID ? 'Carregado' : 'AUSENTE!'}`);
    console.log(`- OPENAI_API_KEY: ${OPENAI_API_KEY ? 'Carregado' : 'AUSENTE!'}`);
    console.log(`- VERIFY_TOKEN: ${VERIFY_TOKEN ? 'Carregado' : 'AUSENTE!'}`);
});


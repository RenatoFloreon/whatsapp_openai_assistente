console.log("[INDEX_JS_TOP_LEVEL] Script execution started at " + new Date().toISOString());
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
const POLLING_INTERVAL_MS = 2000; // Interval between polling checks (2 seconds)

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
app.get("/webhook", (req, res) => {
    console.log("[WEBHOOK_ENTRY] GET request received on /webhook");
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
app.post("/webhook", async (req, res) => {
    console.log("[WEBHOOK_ENTRY] POST request received on /webhook");
    console.log("[WEBHOOK_BODY] Full request body:", JSON.stringify(req.body, null, 2));
    
    const body = req.body;

    if (body.object !== "whatsapp_business_account") {
        console.log("[WEBHOOK] Objeto não é 'whatsapp_business_account'. Ignorando.");
        res.sendStatus(404); 
        return;
    }

    const messageEntry = body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];

    if (!messageEntry) {
        console.log("[WEBHOOK] Recebeu notificação do WhatsApp sem uma entrada de mensagem válida (messages[0] ausente). Ignorando.");
        res.sendStatus(200); 
        return;
    }

    const from = messageEntry.from;
    const messageType = messageEntry.type;
    const userStateKey = `whatsapp_user_status:${from}`;
    const userThreadDataKey = `whatsapp_thread_data:${from}`;

    console.log(`[WEBHOOK] [${from}] Notificação recebida. Tipo: ${messageType}. Iniciando processamento...`);
    res.sendStatus(200); // Acknowledge receipt immediately to WhatsApp

    try {
        console.log(`[DEBUG] [${from}] Ponto A - Antes de consultar Redis. messageType: ${messageType}`);
        let userState = await redis.get(userStateKey);
        console.log(`[REDIS] [${from}] Estado atual do usuário recuperado do Redis: ${userState}`);

        console.log(`[DEBUG] [${from}] Ponto B - Após consultar Redis, antes de verificar tipo de mensagem. messageType: ${messageType}, userState: ${userState}`);

        if (messageType === "request_welcome" || (messageType === "text" && !userState)) {
            console.log(`[DEBUG] [${from}] Ponto B1 - Entrou no bloco de boas-vindas/primeira mensagem de texto.`);
            console.log(`[WEBHOOK] [${from}] Iniciando fluxo de boas-vindas. Estado anterior: ${userState}, Tipo de Mensagem: ${messageType}`);
            await sendWhatsappMessage(from, WELCOME_MESSAGE_1);
            await sendWhatsappMessage(from, WELCOME_MESSAGE_2);
            await redis.set(userStateKey, USER_STATE_AWAITING_INITIAL_PROMPT, "EX", THREAD_EXPIRY_SECONDS * 2);
            console.log(`[REDIS] [${from}] Estado do usuário definido para AWAITING_INITIAL_PROMPT.`);
            return; 
        } else if (messageType === "text") {
            console.log(`[DEBUG] [${from}] Ponto C - Entrou no bloco de processamento de mensagem de TEXTO.`);
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
                if (!threadId) {
                    console.error(`[WEBHOOK] [${from}] Não foi possível obter ou criar threadId. Abortando processamento da IA.`);
                    return; 
                }

                const aiResponse = await handleOpenAICalls(msg_body, threadId, ASSISTANT_ID, from);
                if (aiResponse) {
                    await sendWhatsappMessage(from, aiResponse);
                } else {
                    console.warn(`[WEBHOOK] [${from}] handleOpenAICalls retornou uma resposta vazia ou indefinida. Nenhuma mensagem enviada para o usuário.`);
                }
            } else {
                console.warn(`[WEBHOOK] [${from}] Mensagem de texto recebida em um estado inesperado: ${userState}. Ignorando.`);
            }
        } else {
            console.log(`[DEBUG] [${from}] Ponto D - Entrou no bloco ELSE (mensagem não é de boas-vindas nem de texto).`);
            console.log(`[WEBHOOK] [${from}] Tipo de mensagem (${messageType}) não é 'text' ou 'request_welcome' para o fluxo principal. Ignorando para processamento de IA.`);
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
                await sendWhatsappMessage(from, "Desculpe, a solicitação demorou muito para ser processada pela IA."); // Informa o usuário
                return null; // Retorna null para indicar falha por timeout
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
                console.error(`[OPENAI] [${from}] [Thread: ${threadId}] Nenhuma mensagem de texto da IA encontrada para a execução ${run.id}. Detalhes das mensagens recuperadas:`, JSON.stringify(allMessages.data.slice(0,5), null, 2));
                await sendWhatsappMessage(from, "Não consegui obter uma resposta formatada corretamente da IA desta vez.");
                return null;
            }
        } else if (runStatus === "requires_action") {
             console.error(`[OPENAI] [${from}] [Thread: ${threadId}] Execução ${run.id} requer ação (Function Calling não implementado).`);
             await sendWhatsappMessage(from, "Preciso de realizar uma ação que ainda não sei fazer. Por favor, contacte o suporte.");
             return null;
        } else {
            console.error(`[OPENAI] [${from}] [Thread: ${threadId}] Execução ${run.id} finalizada com status inesperado: ${runStatus}`);
            await sendWhatsappMessage(from, `Desculpe, houve um problema com a IA (status: ${runStatus}).`);
            return null;
        }
    } catch (error) {
        console.error(`[OPENAI] [${from}] [Thread: ${threadId}] Erro durante chamada à API OpenAI:`, error.message, error.stack);
        if (error.response && error.response.data) {
            console.error(`[OPENAI] [${from}] Detalhes do erro da API OpenAI:`, JSON.stringify(error.response.data, null, 2));
        }
        await sendWhatsappMessage(from, "Desculpe, ocorreu um erro ao conectar com a IA. Tente novamente.");
        return null;
    }
}

async function sendWhatsappMessage(to, text) {
    if (!text || String(text).trim() === "") {
        console.warn(`[WHATSAPP_SEND] [${to}] Tentativa de enviar mensagem vazia. Abortando.`);
        return false; // Retorna false para indicar falha
    }
    const messageChunks = [];
    for (let i = 0; i < text.length; i += WHATSAPP_MAX_MESSAGE_LENGTH) {
        messageChunks.push(text.substring(i, i + WHATSAPP_MAX_MESSAGE_LENGTH));
    }

    console.log(`[WHATSAPP_SEND] [${to}] Preparando para enviar ${messageChunks.length} bloco(s) de mensagem.`);

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

        const AXIOS_TIMEOUT = 15000; // Timeout de 15 segundos para a requisição

        try {
            console.log(`[WHATSAPP_SEND] [${to}] Tentando enviar bloco ${i + 1}/${messageChunks.length} para ${url}. Conteúdo (primeiros 50 chars): "${chunk.substring(0,50)}"... Timeout: ${AXIOS_TIMEOUT}ms`);
            await axios.post(url, data, {
                headers: headers,
                timeout: AXIOS_TIMEOUT
            });
            console.log(`[WHATSAPP_SEND] [${to}] Bloco ${i + 1}/${messageChunks.length} enviado com sucesso.`);
        } catch (error) {
            let errorMessage = `[WHATSAPP_SEND] [${to}] Erro ao tentar enviar bloco ${i + 1}/${messageChunks.length}.`;
            if (error.code === "ECONNABORTED" || (error.message && error.message.toLowerCase().includes("timeout"))) {
                errorMessage += ` TIMEOUT (Código: ${error.code || "N/A"}) após ${AXIOS_TIMEOUT}ms. Mensagem: ${error.message}`;
            } else if (error.response) {
                errorMessage += ` Erro de RESPOSTA da API. Status: ${error.response.status}. Data: ${JSON.stringify(error.response.data)}`;
            } else if (error.request) {
                errorMessage += ` Erro de REQUISIÇÃO (sem resposta da API). Detalhes da requisição: ${JSON.stringify(error.request)}`;
            } else {
                errorMessage += ` Erro desconhecido: ${error.message}`;
            }
            console.error(errorMessage, error.stack ? `\nStack: ${error.stack}` : "");
            return false; // Retorna false para indicar falha no envio deste bloco
        }
    }
    return true; // Indica que todos os blocos foram enviados (ou tentados) com sucesso
}

async function handleGenericError(from, customMessage = "Desculpe, ocorreu um erro inesperado. Por favor, tente novamente mais tarde.") {
    console.error(`[ERROR_HANDLER] [${from}] Erro genérico. Enviando mensagem de erro para o usuário.`);
    await sendWhatsappMessage(from, customMessage);
}

async function handleOpenAIError(error, from) {
    let userMessage = "Lamento, ocorreu um problema ao comunicar com a IA. Por favor, tente novamente mais tarde.";
    if (error.response) {
        console.error(`[OPENAI_ERROR_HANDLER] [${from}] Erro da API OpenAI: Status ${error.response.status}`, error.response.data);
    } else {
        console.error(`[OPENAI_ERROR_HANDLER] [${from}] Erro da API OpenAI (sem resposta detalhada):`, error.message);
    }
    await sendWhatsappMessage(from, userMessage);
}

const listener = app.listen(PORT || 3000, () => {
    console.log("[SERVER] Aplicação rodando na porta " + listener.address().port);
});


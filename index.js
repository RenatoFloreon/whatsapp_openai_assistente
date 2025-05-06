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
    connectTimeout: 10000,
    showFriendlyErrorStack: true
});

redis.on("connect", () => console.log("[REDIS] Conectado com sucesso!"));
redis.on("error", (err) => console.error("[REDIS] Erro de conexão:", safeLogError(err)));

// --- Configure OpenAI Client ---
const openai = new OpenAI({
    apiKey: OPENAI_API_KEY,
    organization: OPENAI_ORGANIZATION,
    project: OPENAI_PROJECT,
    timeout: 30 * 1000,
});

// Helper function to safely log errors, avoiding circular structures
function safeLogError(error, additionalContext = {}) {
    const logObject = { ...additionalContext };
    if (error instanceof Error) {
        logObject.message = error.message;
        logObject.name = error.name;
        if (error.stack) {
            logObject.stack = error.stack.split('\n').slice(0, 7).join('\n'); // Log first 7 lines of stack
        }
        if (error.code) {
            logObject.code = error.code;
        }
        // For Axios errors, log specific relevant parts
        if (error.isAxiosError) {
            if (error.config) {
                logObject.axios_config = {
                    url: error.config.url,
                    method: error.config.method,
                    timeout: error.config.timeout,
                };
            }
            if (error.response) {
                logObject.axios_response = {
                    status: error.response.status,
                    statusText: error.response.statusText,
                    data: error.response.data ? JSON.stringify(error.response.data).substring(0, 200) + '...' : undefined, // Log snippet of data
                };
            }
        }
    } else {
        // If it's not an Error object, try to stringify (might be a simple string or object)
        try {
            logObject.error_details = JSON.stringify(error);
        } catch (e) {
            logObject.error_details = "Could not stringify error object";
        }
    }
    return logObject;
}

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
    // Log only a part of the body if it's too large, or use a more robust logger
    console.log("[WEBHOOK_BODY] Full request body (first 500 chars):", JSON.stringify(req.body, null, 2).substring(0, 500));
    
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
    res.sendStatus(200);

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
            console.log(`[WEBHOOK] [${from}] Mensagem de texto recebida: \"${msg_body.substring(0,50)}...\" Estado atual: ${userState}`);

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
                    // Consider sending a generic error message if handleOpenAICalls fails and doesn't send anything.
                    // await sendWhatsappMessage(from, "Desculpe, não consegui processar sua solicitação no momento.");
                }
            } else {
                console.warn(`[WEBHOOK] [${from}] Mensagem de texto recebida em um estado inesperado: ${userState}. Ignorando.`);
            }
        } else {
            console.log(`[DEBUG] [${from}] Ponto D - Entrou no bloco ELSE (mensagem não é de boas-vindas nem de texto).`);
            console.log(`[WEBHOOK] [${from}] Tipo de mensagem (${messageType}) não é 'text' ou 'request_welcome' para o fluxo principal. Ignorando para processamento de IA.`);
        }
    } catch (error) {
        console.error(`[WEBHOOK] [${from}] Erro NÃO TRATADO no processamento principal do webhook (após res.sendStatus(200)):`, safeLogError(error, { from }));
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
        console.error(`[REDIS] [${from}] Erro ao obter dados do tópico ${userThreadDataKey}:`, safeLogError(error, { from, userThreadDataKey }));
        return null;
    }

    if (createNewThread) {
        try {
            console.log(`[OPENAI] [${from}] Tentando criar novo tópico OpenAI...`);
            const thread = await openai.beta.threads.create();
            threadId = thread.id;
            console.log(`[OPENAI] [${from}] Novo tópico criado: ${threadId}`);
        } catch (error) {
            console.error(`[OPENAI] [${from}] Erro na criação do tópico OpenAI:`, safeLogError(error, { from }));
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
        console.error(`[REDIS] [${from}] Erro ao salvar dados do tópico ${userThreadDataKey}:`, safeLogError(error, { from, userThreadDataKey, threadId }));
    }
    return threadId;
}

async function handleOpenAICalls(text, threadId, assistantId, from) {
    console.log(`[OPENAI] [${from}] Iniciando handleOpenAICalls. Thread: ${threadId}, Assistant: ${assistantId}, Mensagem: \"${text.substring(0, 100)}\"...`);
    try {
        console.log(`[OPENAI] [${from}] [Thread: ${threadId}] Adicionando mensagem do usuário ao tópico...`);
        await openai.beta.threads.messages.create(threadId, { role: "user", content: text });
        console.log(`[OPENAI] [${from}] [Thread: ${threadId}] Mensagem do usuário adicionada com sucesso.`);

        console.log(`[OPENAI] [${from}] [Thread: ${threadId}] Criando execução (run) com o assistente ${assistantId}...`);
        const run = await openai.beta.threads.runs.create(threadId, { assistant_id: assistantId });
        console.log(`[OPENAI] [${from}] [Thread: ${threadId}] Execução (run) criada com ID: ${run.id}. Status inicial: ${run.status}`);

        let runStatus = run.status;
        const startTime = Date.now();

        while (runStatus === "queued" || runStatus === "in_progress") {
            if (Date.now() - startTime > POLLING_TIMEOUT_MS) {
                console.error(`[OPENAI] [${from}] [Thread: ${threadId}] Timeout ao aguardar conclusão da execução ${run.id}. Último status: ${runStatus}`);
                await sendWhatsappMessage(from, "Desculpe, a solicitação demorou muito para ser processada pela IA (timeout interno).");
                return null; 
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

            if (assistantMessageFromRun && assistantMessageFromRun.content[0].text.value) {
                const aiMessageContent = assistantMessageFromRun.content[0].text.value;
                console.log(`[OPENAI] [${from}] [Thread: ${threadId}] Conteúdo da mensagem da IA recebido: \"${aiMessageContent.substring(0, 100)}\"...`);
                return aiMessageContent;
            } else {
                console.error(`[OPENAI] [${from}] [Thread: ${threadId}] Nenhuma mensagem de texto da IA encontrada ou conteúdo vazio para a execução ${run.id}. Detalhes das mensagens recuperadas (primeiras 5):`, allMessages.data.slice(0,5).map(m => ({id: m.id, role: m.role, run_id: m.run_id, type: m.content[0]?.type }) ));
                await sendWhatsappMessage(from, "Não consegui obter uma resposta formatada corretamente da IA desta vez (mensagem vazia ou não encontrada).");
                return null;
            }
        } else if (runStatus === "requires_action") {
             console.error(`[OPENAI] [${from}] [Thread: ${threadId}] Execução ${run.id} requer ação (Function Calling não implementado).`);
             await sendWhatsappMessage(from, "A IA precisa realizar uma ação que ainda não está implementada. Por favor, contacte o suporte.");
             return null;
        } else {
            console.error(`[OPENAI] [${from}] [Thread: ${threadId}] Execução ${run.id} finalizada com status problemático: ${runStatus}`);
            await sendWhatsappMessage(from, `Desculpe, houve um problema com a IA (status: ${runStatus}). Tente novamente mais tarde.`);
            return null;
        }
    } catch (error) {
        console.error(`[OPENAI] [${from}] [Thread: ${threadId}] Erro durante chamada à API OpenAI:`, safeLogError(error, { from, threadId }));
        await sendWhatsappMessage(from, "Desculpe, ocorreu um erro ao comunicar com a Inteligência Artificial. Por favor, tente novamente mais tarde.");
        return null;
    }
}

async function sendWhatsappMessage(to, text) {
    if (!text || String(text).trim() === "") {
        console.warn(`[WHATSAPP_SEND] [${to}] Tentativa de enviar mensagem vazia. Abortando.`);
        return false;
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
        
        const AXIOS_TIMEOUT = 15000;

        try {
            console.log(`[WHATSAPP_SEND] [${to}] Tentando enviar bloco ${i + 1}/${messageChunks.length} para ${url}. Conteúdo (primeiros 50 chars): \"${chunk.substring(0,50)}\"... Timeout: ${AXIOS_TIMEOUT}ms`);
            const response = await axios.post(url, data, {
                headers: {
                    "Authorization": `Bearer ${WHATSAPP_TOKEN}`,
                    "Content-Type": "application/json",
                },
                timeout: AXIOS_TIMEOUT 
            });
            console.log(`[WHATSAPP_SEND] [${to}] Bloco ${i + 1}/${messageChunks.length} enviado com sucesso. Status: ${response.status}. Resposta (primeiros 100 chars): ${JSON.stringify(response.data).substring(0,100)}...`);
        } catch (error) {
            console.error(`[WHATSAPP_SEND] [${to}] Erro COMPLETO ao tentar enviar bloco ${i + 1}/${messageChunks.length}:`, safeLogError(error, { to, chunk_info: `Bloco ${i+1}/${messageChunks.length}` }));
            
            if (error.code === 'ECONNABORTED') {
                console.error(`[WHATSAPP_SEND] [${to}] TIMEOUT (Código: ECONNABORTED) ao enviar bloco ${i + 1}/${messageChunks.length} após ${AXIOS_TIMEOUT}ms. Verifique a conectividade de saída da Vercel para graph.facebook.com ou possíveis restrições da Meta.`);
            } else if (error.code === 'ENOTFOUND' || error.code === 'EAI_AGAIN') {
                 console.error(`[WHATSAPP_SEND] [${to}] ERRO DE DNS/REDE (Código: ${error.code}) ao tentar resolver graph.facebook.com. Verifique a conectividade de rede do servidor.`);
            }
            // Consider sending a generic error to the user if this specific send fails, but be careful about error loops.
            // Example: await sendWhatsappMessage(to, "Desculpe, ocorreu um erro ao tentar enviar uma parte da minha resposta. Por favor, tente novamente.");
            // However, since we already sent 200 OK to WhatsApp, further messages might be tricky.
            return false; 
        }
    }
    return true;
}

// --- Server Initialization ---
const serverPort = PORT || 3000;
app.listen(serverPort, () => {
    console.log(`[SERVER] Servidor Express escutando na porta ${serverPort}`);
    console.log(`[SERVER] Webhook URL: /webhook`);
    console.log(`[SERVER] VERIFY_TOKEN: ${VERIFY_TOKEN ? 'Configurado' : 'NÃO CONFIGURADO!'}`);
    console.log(`[SERVER] WHATSAPP_TOKEN: ${WHATSAPP_TOKEN ? 'Configurado' : 'NÃO CONFIGURADO!'}`);
    console.log(`[SERVER] WHATSAPP_PHONE_ID: ${WHATSAPP_PHONE_ID ? 'Configurado' : 'NÃO CONFIGURADO!'}`);
    console.log(`[SERVER] OPENAI_API_KEY: ${OPENAI_API_KEY ? 'Configurado' : 'NÃO CONFIGURADO!'}`);
    console.log(`[SERVER] ASSISTANT_ID: ${ASSISTANT_ID ? 'Configurado' : 'NÃO CONFIGURADO!'}`);
    console.log(`[SERVER] REDIS_URL: ${REDIS_URL ? 'Configurado' : 'NÃO CONFIGURADO!'}`);
});

// Graceful Shutdown
function gracefulShutdown() {
  console.log('[SERVER] Sinal de encerramento recebido. Fechando conexões...');
  redis.quit(() => {
    console.log('[REDIS] Conexão Redis fechada.');
    process.exit(0);
  });
  // Forçar o encerramento após um timeout se o Redis não fechar
  setTimeout(() => {
    console.error('[SERVER] Timeout ao fechar conexão Redis. Forçando encerramento.');
    process.exit(1);
  }, 5000);
}

process.on('SIGTERM', gracefulShutdown);
process.on('SIGINT', gracefulShutdown);


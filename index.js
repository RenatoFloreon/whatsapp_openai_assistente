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
console.log(`[REDIS_SETUP] Tentando inicializar Redis com URL: ${REDIS_URL ? REDIS_URL.substring(0,20) + "..." : "NÃO DEFINIDA"}`);
const redis = new Redis(REDIS_URL, {
    maxRetriesPerRequest: 3,
    connectTimeout: 10000,
    showFriendlyErrorStack: true,
    // Adicionar um timeout para comandos pode ser útil, mas ioredis lida com isso internamente com connectTimeout
    // e timeouts de retry. Se problemas persistirem, pode-se explorar `commandTimeout`.
    // commandTimeout: 5000, // Exemplo: 5 segundos para um comando Redis
    // lazyConnect: true, // Para conectar apenas quando o primeiro comando for emitido, pode ajudar a isolar problemas de conexão inicial
});

redis.on("connect", () => console.log("[REDIS_EVENT] Conectado com sucesso!"));
redis.on("ready", () => console.log("[REDIS_EVENT] Cliente Redis pronto para uso."));
redis.on("error", (err) => console.error("[REDIS_EVENT] Erro de conexão Redis:", safeLogError(err)));
redis.on("close", () => console.log("[REDIS_EVENT] Conexão Redis fechada."));
redis.on("reconnecting", () => console.log("[REDIS_EVENT] Redis reconectando..."));
redis.on("end", () => console.log("[REDIS_EVENT] Conexão Redis terminada (não haverá mais reconexões)."));

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
            logObject.stack = error.stack.split("\n").slice(0, 7).join("\n");
        }
        if (error.code) {
            logObject.code = error.code;
        }
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
                    data: error.response.data ? JSON.stringify(error.response.data).substring(0, 200) + "..." : undefined,
                };
            }
        }
    } else {
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
    console.log(`[WEBHOOK_HANDLER_START] [${req.body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0]?.from || "unknown_sender"}] POST /webhook iniciado.`);
    console.log("[WEBHOOK_BODY] Full request body (first 500 chars):", JSON.stringify(req.body, null, 2).substring(0, 500));
    
    const body = req.body;

    if (body.object !== "whatsapp_business_account") {
        console.log("[WEBHOOK] Objeto não é whatsapp_business_account. Ignorando.");
        res.sendStatus(404); 
        return;
    }

    const messageEntry = body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];

    if (!messageEntry) {
        console.log("[WEBHOOK] Notificação do WhatsApp sem entrada de mensagem válida. Ignorando.");
        res.sendStatus(200);
        return;
    }

    const from = messageEntry.from;
    const messageType = messageEntry.type;
    const userStateKey = `whatsapp_user_status:${from}`;
    const userThreadDataKey = `whatsapp_thread_data:${from}`;

    console.log(`[WEBHOOK] [${from}] Notificação recebida. Tipo: ${messageType}. Iniciando processamento...`);
    res.sendStatus(200); // Acknowledge WhatsApp immediately

    try {
        console.log(`[DEBUG] [${from}] Ponto A - Antes de consultar Redis. userStateKey: ${userStateKey}`);
        let userState = null;
        try {
            console.log(`[REDIS_GET_ATTEMPT] [${from}] Tentando obter estado do usuário: ${userStateKey}`);
            userState = await redis.get(userStateKey);
            console.log(`[REDIS_GET_SUCCESS] [${from}] Estado recuperado do Redis para ${userStateKey}: ${userState}`);
        } catch (redisError) {
            console.error(`[REDIS_GET_ERROR] [${from}] Erro ao tentar obter ${userStateKey} do Redis:`, safeLogError(redisError, { from, userStateKey }));
            // Decide if you want to proceed with a default state or abort
            // For now, let it proceed, userState will be null, potentially triggering welcome flow
        }

        console.log(`[DEBUG] [${from}] Ponto B - Após consultar Redis. messageType: ${messageType}, userState: ${userState}`);

        if (messageType === "request_welcome" || (messageType === "text" && !userState)) {
            console.log(`[DEBUG] [${from}] Ponto B1 - Entrou no bloco de boas-vindas/primeira mensagem de texto.`);
            console.log(`[WEBHOOK] [${from}] Iniciando fluxo de boas-vindas. Estado anterior: ${userState}, Tipo de Mensagem: ${messageType}`);
            await sendWhatsappMessage(from, WELCOME_MESSAGE_1);
            await sendWhatsappMessage(from, WELCOME_MESSAGE_2);
            console.log(`[REDIS_SET_ATTEMPT] [${from}] Tentando definir estado para AWAITING_INITIAL_PROMPT para ${userStateKey}`);
            await redis.set(userStateKey, USER_STATE_AWAITING_INITIAL_PROMPT, "EX", THREAD_EXPIRY_SECONDS * 2);
            console.log(`[REDIS_SET_SUCCESS] [${from}] Estado do usuário definido para AWAITING_INITIAL_PROMPT.`);
            console.log(`[WEBHOOK_HANDLER_END] [${from}] Fluxo de boas-vindas concluído.`);
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
                console.log(`[REDIS_SET_ATTEMPT] [${from}] Tentando definir estado para CONVERSING para ${userStateKey}`);
                await redis.set(userStateKey, USER_STATE_CONVERSING, "EX", THREAD_EXPIRY_SECONDS * 2);
                console.log(`[REDIS_SET_SUCCESS] [${from}] Estado do usuário definido para CONVERSING.`);

                let threadId = await getOrCreateThread(from, userThreadDataKey);
                if (!threadId) {
                    console.error(`[WEBHOOK] [${from}] Não foi possível obter ou criar threadId. Abortando processamento da IA.`);
                    console.log(`[WEBHOOK_HANDLER_END] [${from}] Processamento abortado devido à falha em obter threadId.`);
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
            console.log(`[WEBHOOK] [${from}] Tipo de mensagem (${messageType}) não é text ou request_welcome para o fluxo principal. Ignorando.`);
        }
    } catch (error) {
        console.error(`[WEBHOOK_MAIN_CATCH] [${from}] Erro NÃO TRATADO no processamento principal do webhook:`, safeLogError(error, { from }));
    }
    console.log(`[WEBHOOK_HANDLER_END] [${from || "unknown_sender"}] POST /webhook concluído.`);
});

// --- Helper Functions ---

async function getOrCreateThread(from, userThreadDataKey) {
    console.log(`[GET_OR_CREATE_THREAD] [${from}] Iniciando para ${userThreadDataKey}`);
    let threadId = null;
    let createNewThread = false;
    const now = Date.now();

    try {
        console.log(`[REDIS_GET_ATTEMPT] [${from}] Tentando obter dados do tópico: ${userThreadDataKey}`);
        const threadDataString = await redis.get(userThreadDataKey);
        if (threadDataString) {
            console.log(`[REDIS_GET_SUCCESS] [${from}] Dados do tópico recuperados para ${userThreadDataKey}: ${threadDataString.substring(0,100)}...`);
            const threadData = JSON.parse(threadDataString);
            if (threadData.threadId && threadData.lastInteractionTimestamp) {
                if (now - threadData.lastInteractionTimestamp > THREAD_EXPIRY_MILLISECONDS) {
                    console.log(`[REDIS] [${from}] Tópico ${threadData.threadId} expirado. Criando novo tópico.`);
                    createNewThread = true;
                } else {
                    threadId = threadData.threadId;
                    console.log(`[REDIS] [${from}] Usando tópico existente ${threadId}.`);
                }
            } else {
                console.warn(`[REDIS] [${from}] Dados de tópico inválidos encontrados em ${userThreadDataKey}. Criando novo tópico.`);
                createNewThread = true;
            }
        } else {
            console.log(`[REDIS] [${from}] Nenhum dado de tópico encontrado para ${userThreadDataKey}. Criando novo tópico.`);
            createNewThread = true;
        }
    } catch (error) {
        console.error(`[REDIS_GET_THREAD_ERROR] [${from}] Erro ao obter dados do tópico ${userThreadDataKey}:`, safeLogError(error, { from, userThreadDataKey }));
        return null;
    }

    if (createNewThread) {
        try {
            console.log(`[OPENAI_CREATE_THREAD_ATTEMPT] [${from}] Tentando criar novo tópico OpenAI...`);
            const thread = await openai.beta.threads.create();
            threadId = thread.id;
            console.log(`[OPENAI_CREATE_THREAD_SUCCESS] [${from}] Novo tópico OpenAI criado: ${threadId}`);
        } catch (error) {
            console.error(`[OPENAI_CREATE_THREAD_ERROR] [${from}] Erro na criação do tópico OpenAI:`, safeLogError(error, { from }));
            return null;
        }
    }

    try {
        const newThreadData = JSON.stringify({ 
            threadId: threadId, 
            lastInteractionTimestamp: now 
        });
        console.log(`[REDIS_SET_ATTEMPT] [${from}] Tentando salvar/atualizar dados do tópico ${threadId} em ${userThreadDataKey}`);
        await redis.set(userThreadDataKey, newThreadData, "EX", THREAD_EXPIRY_SECONDS * 2); 
        console.log(`[REDIS_SET_SUCCESS] [${from}] Dados do tópico ${threadId} atualizados/salvos em ${userThreadDataKey}.`);
    } catch (error) {
        console.error(`[REDIS_SET_THREAD_ERROR] [${from}] Erro ao salvar dados do tópico ${userThreadDataKey}:`, safeLogError(error, { from, userThreadDataKey, threadId }));
        // Não retorna null aqui, pois o threadId foi obtido/criado, apenas o save no Redis falhou.
        // O impacto é que na próxima vez pode criar um novo thread se este save falhar consistentemente.
    }
    console.log(`[GET_OR_CREATE_THREAD] [${from}] Concluído. Retornando threadId: ${threadId}`);
    return threadId;
}

async function handleOpenAICalls(text, threadId, assistantId, from) {
    console.log(`[OPENAI_HANDLER] [${from}] Iniciando. Thread: ${threadId}, Assistant: ${assistantId}, Mensagem: \"${text.substring(0, 100)}\"...`);
    try {
        console.log(`[OPENAI_ADD_MSG_ATTEMPT] [${from}] [Thread: ${threadId}] Adicionando mensagem do usuário...`);
        await openai.beta.threads.messages.create(threadId, { role: "user", content: text });
        console.log(`[OPENAI_ADD_MSG_SUCCESS] [${from}] [Thread: ${threadId}] Mensagem do usuário adicionada.`);

        console.log(`[OPENAI_CREATE_RUN_ATTEMPT] [${from}] [Thread: ${threadId}] Criando execução com assistente ${assistantId}...`);
        const run = await openai.beta.threads.runs.create(threadId, { assistant_id: assistantId });
        console.log(`[OPENAI_CREATE_RUN_SUCCESS] [${from}] [Thread: ${threadId}] Execução criada ID: ${run.id}. Status: ${run.status}`);

        let runStatus = run.status;
        const startTime = Date.now();

        while (runStatus === "queued" || runStatus === "in_progress") {
            if (Date.now() - startTime > POLLING_TIMEOUT_MS) {
                console.error(`[OPENAI_RUN_TIMEOUT] [${from}] [Thread: ${threadId}] Timeout (run ${run.id}). Status: ${runStatus}`);
                await sendWhatsappMessage(from, "Desculpe, a solicitação demorou muito para ser processada pela IA (timeout interno).");
                return null; 
            }
            await new Promise(resolve => setTimeout(resolve, POLLING_INTERVAL_MS));
            console.log(`[OPENAI_POLL_RUN_ATTEMPT] [${from}] [Thread: ${threadId}] Verificando status da execução ${run.id}...`);
            const currentRun = await openai.beta.threads.runs.retrieve(threadId, run.id);
            runStatus = currentRun.status;
            console.log(`[OPENAI_POLL_RUN_STATUS] [${from}] [Thread: ${threadId}] Status da execução ${run.id}: ${runStatus}`);
        }

        if (runStatus === "completed") {
            console.log(`[OPENAI_RUN_COMPLETED] [${from}] [Thread: ${threadId}] Execução ${run.id} completada. Buscando mensagens...`);
            const allMessages = await openai.beta.threads.messages.list(threadId, { order: "desc", limit: 20 });
            
            const assistantMessageFromRun = allMessages.data.find(
                (msg) => msg.role === "assistant" && msg.run_id === run.id && msg.content[0]?.type === "text"
            );

            if (assistantMessageFromRun && assistantMessageFromRun.content[0].text.value) {
                const aiMessageContent = assistantMessageFromRun.content[0].text.value;
                console.log(`[OPENAI_MSG_RECEIVED] [${from}] [Thread: ${threadId}] Conteúdo da IA: \"${aiMessageContent.substring(0, 100)}\"...`);
                return aiMessageContent;
            } else {
                console.error(`[OPENAI_NO_ASSISTANT_MSG] [${from}] [Thread: ${threadId}] Nenhuma mensagem de texto da IA encontrada para run ${run.id}. Mensagens:`, allMessages.data.slice(0,5).map(m => ({id: m.id, role: m.role, run_id: m.run_id, type: m.content[0]?.type }) ));
                await sendWhatsappMessage(from, "Não consegui obter uma resposta formatada corretamente da IA desta vez (mensagem vazia ou não encontrada).");
                return null;
            }
        } else if (runStatus === "requires_action") {
             console.error(`[OPENAI_RUN_REQUIRES_ACTION] [${from}] [Thread: ${threadId}] Execução ${run.id} requer ação (Function Calling não implementado).`);
             await sendWhatsappMessage(from, "A IA precisa realizar uma ação que ainda não está implementada. Por favor, contacte o suporte.");
             return null;
        } else {
            console.error(`[OPENAI_RUN_FAILED] [${from}] [Thread: ${threadId}] Execução ${run.id} finalizada com status problemático: ${runStatus}`);
            await sendWhatsappMessage(from, `Desculpe, houve um problema com a IA (status: ${runStatus}). Tente novamente mais tarde.`);
            return null;
        }
    } catch (error) {
        console.error(`[OPENAI_HANDLER_ERROR] [${from}] [Thread: ${threadId}] Erro durante chamada OpenAI:`, safeLogError(error, { from, threadId }));
        await sendWhatsappMessage(from, "Desculpe, ocorreu um erro ao comunicar com a Inteligência Artificial. Por favor, tente novamente mais tarde.");
        return null;
    }
}

async function sendWhatsappMessage(to, text) {
    if (!text || String(text).trim() === "") {
        console.warn(`[WHATSAPP_SEND_EMPTY] [${to}] Tentativa de enviar mensagem vazia. Abortando.`);
        return false;
    }
    const messageChunks = [];
    for (let i = 0; i < text.length; i += WHATSAPP_MAX_MESSAGE_LENGTH) {
        messageChunks.push(text.substring(i, i + WHATSAPP_MAX_MESSAGE_LENGTH));
    }

    console.log(`[WHATSAPP_SEND_PREPARE] [${to}] Preparando para enviar ${messageChunks.length} bloco(s).`);

    for (let i = 0; i < messageChunks.length; i++) {
        const chunk = messageChunks[i];
        const url = `https://graph.facebook.com/v19.0/${WHATSAPP_PHONE_ID}/messages`;
        const data = {
            messaging_product: "whatsapp",
            to: to,
            type: "text",
            text: { body: chunk },
        };
        
        const AXIOS_TIMEOUT = 15000; // Mantido o timeout de 15s para chamadas ao WhatsApp

        try {
            console.log(`[WHATSAPP_SEND_ATTEMPT] [${to}] Enviando bloco ${i + 1}/${messageChunks.length} para ${url}. Conteúdo (primeiros 50 chars): \"${chunk.substring(0,50)}\"... Timeout: ${AXIOS_TIMEOUT}ms`);
            const response = await axios.post(url, data, {
                headers: {
                    "Authorization": `Bearer ${WHATSAPP_TOKEN}`,
                    "Content-Type": "application/json",
                },
                timeout: AXIOS_TIMEOUT 
            });
            console.log(`[WHATSAPP_SEND_SUCCESS] [${to}] Bloco ${i + 1}/${messageChunks.length} enviado. Status: ${response.status}. Resposta (primeiros 100 chars): ${JSON.stringify(response.data).substring(0,100)}...`);
        } catch (error) {
            console.error(`[WHATSAPP_SEND_ERROR] [${to}] Erro ao enviar bloco ${i + 1}/${messageChunks.length}:`, safeLogError(error, { to, chunk_info: `Bloco ${i+1}/${messageChunks.length}` }));
            
            if (error.code === "ECONNABORTED") {
                console.error(`[WHATSAPP_SEND_TIMEOUT] [${to}] TIMEOUT (ECONNABORTED) ao enviar bloco ${i + 1}/${messageChunks.length} após ${AXIOS_TIMEOUT}ms.`);
            } else if (error.code === "ENOTFOUND" || error.code === "EAI_AGAIN") {
                 console.error(`[WHATSAPP_SEND_DNS_ERROR] [${to}] ERRO DE DNS/REDE (Código: ${error.code}) ao tentar resolver graph.facebook.com.`);
            }
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
    // Adicionar mais logs de inicialização para variáveis de ambiente críticas
    console.log(`[ENV_CHECK] VERIFY_TOKEN: ${VERIFY_TOKEN ? "Configurado" : "NÃO CONFIGURADO!"}`);
    console.log(`[ENV_CHECK] WHATSAPP_TOKEN: ${WHATSAPP_TOKEN ? "Configurado" : "NÃO CONFIGURADO!"}`);
    console.log(`[ENV_CHECK] WHATSAPP_PHONE_ID: ${WHATSAPP_PHONE_ID ? "Configurado" : "NÃO CONFIGURADO!"}`);
    console.log(`[ENV_CHECK] OPENAI_API_KEY: ${OPENAI_API_KEY ? "Configurado" : "NÃO CONFIGURADO!"}`);
    console.log(`[ENV_CHECK] ASSISTANT_ID: ${ASSISTANT_ID ? "Configurado" : "NÃO CONFIGURADO!"}`);
    console.log(`[ENV_CHECK] REDIS_URL: ${REDIS_URL ? "Configurado (início: " + REDIS_URL.substring(0,20) + "...)" : "NÃO CONFIGURADO!"}`);
});

// Graceful Shutdown
function gracefulShutdown(signal) {
  console.log(`[SERVER_SHUTDOWN] Sinal ${signal} recebido. Fechando conexões...`);
  // Fechar o servidor HTTP primeiro para não aceitar novas conexões
  const server = app.listen(); // Isto é um placeholder, o servidor já está a escutar.
                               // Precisamos de uma referência ao servidor real para fechar.
                               // No entanto, em ambientes serverless como Vercel, o graceful shutdown do HTTP é gerido pela plataforma.
                               // O foco aqui é fechar conexões externas como Redis.
  
  redis.quit((err, res) => {
    if (err) {
        console.error("[REDIS_SHUTDOWN_ERROR] Erro ao fechar conexão Redis:", safeLogError(err));
    } else {
        console.log("[REDIS_SHUTDOWN_SUCCESS] Conexão Redis fechada com sucesso.");
    }
    console.log("[SERVER_SHUTDOWN] Processo terminando.");
    process.exit(err ? 1 : 0);
  });

  setTimeout(() => {
    console.error("[SERVER_SHUTDOWN_TIMEOUT] Timeout ao fechar conexões. Forçando encerramento.");
    process.exit(1);
  }, 10000); // Aumentado para 10s para dar mais tempo ao Redis
}

process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));

console.log("[INDEX_JS_BOTTOM_LEVEL] Script execution finished initialization.");


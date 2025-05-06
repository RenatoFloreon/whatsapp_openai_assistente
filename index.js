require("dotenv").config();
const express = require("express");
const crypto = require("crypto");
const OpenAI = require("openai");
const Redis = require("ioredis");
const fetch = require("node-fetch");

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const ASSISTANT_ID = process.env.ASSISTANT_ID;
const REDIS_URL = process.env.REDIS_URL;
const WHATSAPP_PHONE_ID = process.env.WHATSAPP_PHONE_ID;

const FETCH_TIMEOUT_MS = parseInt(process.env.FETCH_TIMEOUT_MS) || 20000;
const OPENAI_TIMEOUT_MS = parseInt(process.env.OPENAI_TIMEOUT_MS) || 30000;
// Nova variável de ambiente para controlar o rejectUnauthorized do TLS do Redis
const REDIS_TLS_REJECT_UNAUTHORIZED = process.env.REDIS_TLS_REJECT_UNAUTHORIZED !== 'false'; // Padrão é true

console.log("[INDEX_JS_TOP_LEVEL] Execução do script iniciada em", new Date().toISOString(), "Servidor escutando na porta", PORT);
console.log(`[INDEX_JS_TOP_LEVEL] REDIS_URL: ${REDIS_URL ? 'Definida' : 'NÃO DEFINIDA'}`);
console.log(`[INDEX_JS_TOP_LEVEL] REDIS_TLS_REJECT_UNAUTHORIZED: ${REDIS_TLS_REJECT_UNAUTHORIZED}`);
console.log(`[INDEX_JS_TOP_LEVEL] OPENAI_API_KEY: ${OPENAI_API_KEY ? 'Definida' : 'NÃO DEFINIDA'}`);
// ... (restante dos logs de variáveis de ambiente)

let openai;
if (OPENAI_API_KEY) {
    openai = new OpenAI({ apiKey: OPENAI_API_KEY });
    console.log("[INDEX_JS_TOP_LEVEL] Instância OpenAI criada com sucesso.");
} else {
    console.error("[INDEX_JS_TOP_LEVEL_ERROR] OPENAI_API_KEY não está definida. A funcionalidade da OpenAI será desativada.");
}

let redis;
if (REDIS_URL) {
    try {
        console.log(`[REDIS_INIT_ATTEMPT] Tentando inicializar o Redis com a URL: ${REDIS_URL.substring(0, REDIS_URL.indexOf("://") + 3)}... e REDIS_TLS_REJECT_UNAUTHORIZED: ${REDIS_TLS_REJECT_UNAUTHORIZED}`);
        
        const redisOptions = {
            maxRetriesPerRequest: 3, // Mantém 3 tentativas
            connectTimeout: 15000,    // Aumenta o timeout de conexão para 15s
            retryStrategy(times) {
                const delay = Math.min(times * 200, 2000); // Aumenta o delay entre tentativas, max 2s
                console.log(`[REDIS_RETRY_STRATEGY] Tentativa de reconexão Redis #${times}. Próxima tentativa em ${delay}ms.`);
                return delay;
            }
        };

        if (REDIS_URL.startsWith("rediss://")) {
            redisOptions.tls = {
                rejectUnauthorized: REDIS_TLS_REJECT_UNAUTHORIZED,
                // Tentar forçar uma versão TLS específica, se necessário (ex: 'TLSv1.2')
                // servername: new URL(REDIS_URL).hostname // Adicionar servername pode ajudar com SNI
            };
            console.log("[REDIS_INIT_TLS_CONFIG] Configuração TLS para Redis: ", redisOptions.tls);
        } else {
            console.log("[REDIS_INIT_NO_TLS] Conectando ao Redis sem TLS (URL não começa com rediss://).");
        }

        redis = new Redis(REDIS_URL, redisOptions);

        redis.on("connect", () => console.log("[REDIS_EVENT] Conectado com sucesso ao Redis!"));
        redis.on("ready", () => console.log("[REDIS_EVENT] Cliente Redis pronto para uso."));
        redis.on("error", (err) => {
            console.error("[REDIS_EVENT_ERROR] Erro de conexão/operação com o Redis:", safeLogError(err));
            // Se for um erro de TLS específico, podemos logar mais detalhes
            if (err.message && (err.message.includes('SSL') || err.message.includes('TLS'))) {
                console.error("[REDIS_TLS_ERROR_DETAIL] Detalhes do erro TLS: code=", err.code, "syscall=", err.syscall, "reason=", err.reason);
            }
        });
        redis.on("close", () => console.log("[REDIS_EVENT] Conexão com o Redis fechada."));
        redis.on("reconnecting", (delay) => console.log(`[REDIS_EVENT] Tentando reconectar ao Redis... Próxima tentativa em ${delay}ms`));
        redis.on("end", () => console.log("[REDIS_EVENT] Conexão com o Redis terminada (não haverá mais reconexões)."));

    } catch (error) {
        console.error("[REDIS_INIT_ERROR] Erro CRÍTICO ao inicializar o cliente Redis:", safeLogError(error));
        redis = null; 
    }
} else {
    console.error("[REDIS_INIT_ERROR] REDIS_URL não está definida. O Redis não será utilizado.");
}

// ... (restante do código como em index_v5_openai_debug.js, incluindo safeLogError, sendWhatsappMessage, e as rotas do Express)
// A função safeLogError, sendWhatsappMessage, e as rotas app.post("/webhook"), app.get("/webhook"), app.get("/"), app.use(), app.listen() permanecem as mesmas
// que em index_v5_openai_debug.js. Apenas a inicialização do Redis foi alterada.

// Função para logar erros de forma segura, evitando estruturas circulares
function safeLogError(error, additionalInfo = {}) {
    const errorDetails = {
        message: error.message,
        name: error.name,
        stack: error.stack ? error.stack.split("\n").slice(0, 5).join("\n") : "No stack trace", // Limita o stack trace
        code: error.code,
        errno: error.errno,
        syscall: error.syscall,
        address: error.address,
        port: error.port,
        config: error.config ? { url: error.config.url, method: error.config.method, headers: error.config.headers, timeout: error.config.timeout } : undefined,
        response: error.response ? { status: error.response.status, statusText: error.response.statusText, data: error.response.data } : undefined,
        ...additionalInfo
    };
    Object.keys(errorDetails).forEach(key => errorDetails[key] === undefined && delete errorDetails[key]);
    return JSON.stringify(errorDetails, null, 2);
}

async function sendWhatsappMessage(phoneNumber, messageBlocks, attempt = 1, maxAttempts = 2) {
    if (!WHATSAPP_TOKEN || !WHATSAPP_PHONE_ID) {
        console.error("[WHATSAPP_SEND_ERROR] WHATSAPP_TOKEN ou WHATSAPP_PHONE_ID não definidos. Não é possível enviar mensagem.");
        return;
    }
    for (let i = 0; i < messageBlocks.length; i++) {
        const messageData = {
            messaging_product: "whatsapp",
            to: phoneNumber,
            text: { body: messageBlocks[i] },
        };
        const chunkInfo = `Bloco ${i + 1}/${messageBlocks.length}`;
        console.log(`[WHATSAPP_SEND_ATTEMPT] [${phoneNumber}] Enviando ${chunkInfo}: "${messageBlocks[i].substring(0,50)}..."`);
        try {
            const response = await fetch(`https://graph.facebook.com/v19.0/${WHATSAPP_PHONE_ID}/messages`, {
                method: "POST",
                headers: {
                    "Authorization": `Bearer ${WHATSAPP_TOKEN}`,
                    "Content-Type": "application/json",
                },
                body: JSON.stringify(messageData),
                timeout: FETCH_TIMEOUT_MS,
            });
            const responseText = await response.text(); 
            if (!response.ok) {
                console.error(`[WHATSAPP_SEND_ERROR] [${phoneNumber}] Erro ao enviar ${chunkInfo}. Status: ${response.status} ${response.statusText}. Resposta: ${responseText}`);
                continue; 
            }
            console.log(`[WHATSAPP_SEND_SUCCESS] [${phoneNumber}] ${chunkInfo} enviado. Status: ${response.status}. Resposta: ${responseText}`);
        } catch (error) {
            console.error(`[WHATSAPP_SEND_ERROR] [${phoneNumber}] Erro de rede ao enviar ${chunkInfo}:`, safeLogError(error, { chunk_info: chunkInfo }));
            if (attempt < maxAttempts && (error.code === 'ETIMEDOUT' || error.code === 'ECONNABORTED' || error.code === 'ECONNRESET')) {
                console.log(`[WHATSAPP_SEND_RETRY] [${phoneNumber}] Tentando novamente (${attempt + 1}/${maxAttempts}) para ${chunkInfo} em 2 segundos...`);
                await new Promise(resolve => setTimeout(resolve, 2000));
                await sendWhatsappMessage(phoneNumber, [messageBlocks[i]], attempt + 1, maxAttempts); 
            } else {
                console.error(`[WHATSAPP_SEND_FAIL] [${phoneNumber}] Falha final ao enviar ${chunkInfo} após ${attempt} tentativas.`);
            }
        }
        if (i < messageBlocks.length - 1) {
            await new Promise(resolve => setTimeout(resolve, 700)); 
        }
    }
}

app.post("/webhook", async (req, res) => {
    console.log("[WEBHOOK_HANDLER_START]", req.method, req.url, "Webhook recebido.");
    const body = req.body;
    console.log("[WEBHOOK_BODY] Corpo completo da solicitação (primeiros 500 caracteres):", JSON.stringify(body).substring(0, 500));
    if (body.object === "whatsapp_business_account") {
        if (body.entry && body.entry[0].changes && body.entry[0].changes[0].value.messages && body.entry[0].changes[0].value.messages[0]) {
            const message = body.entry[0].changes[0].value.messages[0];
            const from = message.from;
            const messageType = message.type;
            if (message.type === "text" || message.type === "interactive" || message.type === "button_template_reply" || message.type === "list_reply" || message.type === "quick_reply_button") {
            } else if (message.type === "system") {
                console.log(`[WEBHOOK] [${from}] Mensagem do sistema recebida: ${message.system.body}. Ignorando.`);
                res.sendStatus(200);
                return;
            } else if (message.type !== "text" && message.type !== "interactive" && message.type !== "button_template_reply" && message.type !== "list_reply" && message.type !== "quick_reply_button") {
                 console.log(`[WEBHOOK] [${from}] Tipo de mensagem '${message.type}' não suportado. Enviando mensagem de aviso.`);
                 await sendWhatsappMessage(from, ["Desculpe, este tipo de mensagem ainda não é suportado."]);
                 res.sendStatus(200);
                 return;
            }
        } else {
            if (body.entry && body.entry[0].changes && body.entry[0].changes[0].value.statuses) {
                const statusUpdate = body.entry[0].changes[0].value.statuses[0];
                console.log(`[WEBHOOK_STATUS] [${statusUpdate.recipient_id}] Status da mensagem ${statusUpdate.id}: ${statusUpdate.status}. Conversa: ${statusUpdate.conversation ? statusUpdate.conversation.id : 'N/A'}`);
            } else {
                console.log("[WEBHOOK] Notificação do WhatsApp sem entrada de mensagem válida. Ignorando.", JSON.stringify(body).substring(0, 200));
            }
            res.sendStatus(200);
            return;
        }
        const message = body.entry[0].changes[0].value.messages[0];
        const from = message.from; 
        const userMessageContent = message.text ? message.text.body : 
                                (message.interactive && message.interactive.button_reply) ? message.interactive.button_reply.title :
                                (message.interactive && message.interactive.list_reply) ? message.interactive.list_reply.title :
                                "Conteúdo não extraível";
        console.log(`[USER_MESSAGE] [${from}] Mensagem recebida: "${userMessageContent}"`);
        if (!redis) {
            console.error(`[CONVERSATION_ERROR] [${from}] Redis não está disponível. Não é possível processar a mensagem.`);
            await sendWhatsappMessage(from, ["Ocorreu um erro interno (Redis indisponível). Por favor, tente novamente mais tarde."]);
            res.sendStatus(200); 
            return;
        }
        if (!openai) {
            console.error(`[CONVERSATION_ERROR] [${from}] OpenAI não está disponível. Não é possível processar a mensagem.`);
            await sendWhatsappMessage(from, ["Ocorreu um erro interno (OpenAI indisponível). Por favor, tente novamente mais tarde."]);
            res.sendStatus(200);
            return;
        }
        const userStateKey = `whatsapp:user_status:${from}`;
        const threadDataKey = `whatsapp:thread_data:${from}`;
        try {
            console.log(`[REDIS_GET_ATTEMPT] [${from}] Tentando obter estado do usuário: ${userStateKey}`);
            let userState = await redis.get(userStateKey);
            console.log(`[REDIS_GET_SUCCESS] [${from}] Estado recuperado do Redis para ${userStateKey}: ${userState}`);
            let threadId;
            let runId;
            if (!userState) {
                console.log(`[CONVERSATION_NEW] [${from}] Novo usuário ou estado expirado. Enviando mensagem de boas-vindas e criando novo tópico.`);
                await sendWhatsappMessage(from, ["Olá! Sou seu assistente virtual. Como posso ajudar hoje?"]);
                await sendWhatsappMessage(from, ["Estou processando sua solicitação, aguarde um momento..."]);
                console.log(`[OPENAI_CREATE_THREAD_ATTEMPT] [${from}] Tentando criar novo Tópico OpenAI.`);
                try {
                    const threadStartTime = Date.now();
                    const thread = await openai.beta.threads.create({ timeout: OPENAI_TIMEOUT_MS });
                    threadId = thread.id;
                    console.log(`[OPENAI_CREATE_THREAD_SUCCESS] [${from}] Tópico OpenAI criado: ${threadId} em ${Date.now() - threadStartTime}ms`);
                    const threadData = { threadId: threadId, lastInteraction: Date.now() };
                    console.log(`[REDIS_SET_ATTEMPT] [${from}] Tentando definir dados do tópico no Redis para ${threadDataKey}:`, threadData);
                    await redis.set(threadDataKey, JSON.stringify(threadData), "EX", 7200); 
                    console.log(`[REDIS_SET_SUCCESS] [${from}] Dados do tópico definidos no Redis para ${threadDataKey}`);
                } catch (error) {
                    console.error(`[OPENAI_CREATE_THREAD_ERROR] [${from}] Erro ao criar tópico OpenAI:`, safeLogError(error));
                    await sendWhatsappMessage(from, ["Desculpe, não consegui iniciar nossa conversa com o assistente. Por favor, tente novamente."]);
                    res.sendStatus(200);
                    return;
                }
                userState = "CONVERSING";
                console.log(`[REDIS_SET_ATTEMPT] [${from}] Tentando definir estado do usuário para ${userState} em ${userStateKey}`);
                await redis.set(userStateKey, userState, "EX", 7200);
                console.log(`[REDIS_SET_SUCCESS] [${from}] Estado do usuário definido para ${userState} em ${userStateKey}`);
            } else {
                console.log(`[CONVERSATION_CONTINUE] [${from}] Usuário existente em estado: ${userState}. Recuperando threadId.`);
                await sendWhatsappMessage(from, ["Estou processando sua solicitação, aguarde um momento..."]);
                console.log(`[REDIS_GET_ATTEMPT] [${from}] Tentando obter dados do tópico do Redis: ${threadDataKey}`);
                const storedThreadData = await redis.get(threadDataKey);
                if (storedThreadData) {
                    const parsedData = JSON.parse(storedThreadData);
                    threadId = parsedData.threadId;
                    console.log(`[REDIS_GET_SUCCESS] [${from}] Tópico OpenAI recuperado do Redis: ${threadId}`);
                    parsedData.lastInteraction = Date.now();
                    console.log(`[REDIS_SET_ATTEMPT] [${from}] Tentando atualizar dados do tópico no Redis para ${threadDataKey}:`, parsedData);
                    await redis.set(threadDataKey, JSON.stringify(parsedData), "EX", 7200);
                    console.log(`[REDIS_SET_SUCCESS] [${from}] Dados do tópico atualizados no Redis para ${threadDataKey}`);
                } else {
                    console.warn(`[CONVERSATION_WARN] [${from}] Estado do usuário existe (${userState}), mas não há dados de tópico no Redis. Criando novo tópico.`);
                    console.log(`[OPENAI_CREATE_THREAD_ATTEMPT] [${from}] Tentando criar novo Tópico OpenAI (dados não encontrados no Redis).`);
                     try {
                        const threadStartTime = Date.now();
                        const thread = await openai.beta.threads.create({ timeout: OPENAI_TIMEOUT_MS });
                        threadId = thread.id;
                        console.log(`[OPENAI_CREATE_THREAD_SUCCESS] [${from}] Tópico OpenAI criado: ${threadId} em ${Date.now() - threadStartTime}ms`);
                        const threadData = { threadId: threadId, lastInteraction: Date.now() };
                        await redis.set(threadDataKey, JSON.stringify(threadData), "EX", 7200);
                    } catch (error) {
                        console.error(`[OPENAI_CREATE_THREAD_ERROR] [${from}] Erro ao criar tópico OpenAI (dados não encontrados no Redis):`, safeLogError(error));
                        await sendWhatsappMessage(from, ["Desculpe, tive um problema ao tentar continuar nossa conversa. Por favor, tente novamente."]);
                        res.sendStatus(200);
                        return;
                    }
                }
            }
            if (!threadId) {
                console.error(`[OPENAI_ERROR] [${from}] threadId não está definido. Não é possível continuar.`);
                await sendWhatsappMessage(from, ["Ocorreu um erro crítico ao tentar processar sua solicitação (threadId ausente). Por favor, tente mais tarde."]);
                res.sendStatus(200);
                return;
            }
            console.log(`[OPENAI_ADD_MESSAGE_ATTEMPT] [${from}] Adicionando mensagem ao tópico ${threadId}: "${userMessageContent}"`);
            try {
                const msgStartTime = Date.now();
                await openai.beta.threads.messages.create(threadId, { role: "user", content: userMessageContent }, { timeout: OPENAI_TIMEOUT_MS });
                console.log(`[OPENAI_ADD_MESSAGE_SUCCESS] [${from}] Mensagem adicionada ao tópico ${threadId} em ${Date.now() - msgStartTime}ms`);
            } catch (error) {
                console.error(`[OPENAI_ADD_MESSAGE_ERROR] [${from}] Erro ao adicionar mensagem ao tópico ${threadId}:`, safeLogError(error));
                await sendWhatsappMessage(from, ["Desculpe, não consegui enviar sua mensagem para o assistente. Por favor, tente novamente."]);
                res.sendStatus(200);
                return;
            }
            console.log(`[OPENAI_CREATE_RUN_ATTEMPT] [${from}] Criando execução para o tópico ${threadId} com assistente ${ASSISTANT_ID}`);
            try {
                const runStartTime = Date.now();
                const run = await openai.beta.threads.runs.create(threadId, { assistant_id: ASSISTANT_ID }, { timeout: OPENAI_TIMEOUT_MS });
                runId = run.id;
                console.log(`[OPENAI_CREATE_RUN_SUCCESS] [${from}] Execução criada: ${runId} para o tópico ${threadId} em ${Date.now() - runStartTime}ms`);
            } catch (error) {
                console.error(`[OPENAI_CREATE_RUN_ERROR] [${from}] Erro ao criar execução para o tópico ${threadId}:`, safeLogError(error));
                await sendWhatsappMessage(from, ["Desculpe, não consegui iniciar o processamento da sua solicitação com o assistente. Por favor, tente novamente."]);
                res.sendStatus(200);
                return;
            }
            let runStatus;
            const startTime = Date.now();
            const timeout = 60000; 
            console.log(`[OPENAI_POLL_RUN_STATUS_START] [${from}] Iniciando polling para status da execução ${runId} (tópico ${threadId})`);
            do {
                if (Date.now() - startTime > timeout) {
                    console.error(`[OPENAI_POLL_RUN_STATUS_TIMEOUT] [${from}] Timeout (60s) esperando pela conclusão da execução ${runId}.`);
                    await sendWhatsappMessage(from, ["O assistente está demorando muito para responder. Por favor, tente novamente em alguns instantes."]);
                    res.sendStatus(200);
                    return;
                }
                await new Promise(resolve => setTimeout(resolve, 2000)); 
                try {
                    const retrieveStartTime = Date.now();
                    const currentRun = await openai.beta.threads.runs.retrieve(threadId, runId, { timeout: OPENAI_TIMEOUT_MS });
                    runStatus = currentRun.status;
                    console.log(`[OPENAI_POLL_RUN_STATUS_UPDATE] [${from}] Status da execução ${runId}: ${runStatus} (após ${Date.now() - retrieveStartTime}ms para retrieve)`);
                } catch (error) {
                    console.error(`[OPENAI_POLL_RUN_STATUS_ERROR] [${from}] Erro ao recuperar status da execução ${runId}:`, safeLogError(error));
                    await sendWhatsappMessage(from, ["Ocorreu um erro ao verificar o progresso com o assistente. Por favor, tente novamente."]);
                    res.sendStatus(200);
                    return;
                }
            } while (runStatus !== "completed" && runStatus !== "failed" && runStatus !== "cancelled" && runStatus !== "expired" && runStatus !== "requires_action");
            if (runStatus === "completed") {
                console.log(`[OPENAI_RUN_COMPLETED] [${from}] Execução ${runId} completada.`);
                try {
                    const listMsgStartTime = Date.now();
                    const messages = await openai.beta.threads.messages.list(threadId, { limit: 5, order: 'desc' }, { timeout: OPENAI_TIMEOUT_MS });
                    console.log(`[OPENAI_LIST_MESSAGES_SUCCESS] [${from}] Mensagens recuperadas do tópico ${threadId} em ${Date.now() - listMsgStartTime}ms. Total: ${messages.data.length}`);
                    const assistantResponses = messages.data.filter(msg => msg.role === "assistant");
                    if (assistantResponses.length > 0) {
                        const latestAssistantMessage = assistantResponses[0]; 
                        if (latestAssistantMessage.content && latestAssistantMessage.content[0] && latestAssistantMessage.content[0].type === "text") {
                            const assistantReply = latestAssistantMessage.content[0].text.value;
                            console.log(`[OPENAI_ASSISTANT_REPLY] [${from}] Resposta do assistente: "${assistantReply.substring(0,100)}..."`);
                            const MAX_LENGTH = 1600;
                            const responseBlocks = [];
                            for (let i = 0; i < assistantReply.length; i += MAX_LENGTH) {
                                responseBlocks.push(assistantReply.substring(i, i + MAX_LENGTH));
                            }
                            await sendWhatsappMessage(from, responseBlocks);
                        } else {
                            console.warn(`[OPENAI_ASSISTANT_REPLY_WARN] [${from}] Resposta do assistente não continha texto esperado. Conteúdo:`, JSON.stringify(latestAssistantMessage.content).substring(0,200));
                            await sendWhatsappMessage(from, ["O assistente respondeu, mas não consegui processar o formato da resposta."]);
                        }
                    } else {
                        console.warn(`[OPENAI_ASSISTANT_REPLY_WARN] [${from}] Nenhuma mensagem do assistente encontrada após a execução completada.`);
                        await sendWhatsappMessage(from, ["O assistente processou sua solicitação, mas não forneceu uma resposta desta vez."]);
                    }
                } catch (error) {
                    console.error(`[OPENAI_LIST_MESSAGES_ERROR] [${from}] Erro ao listar mensagens do tópico ${threadId}:`, safeLogError(error));
                    await sendWhatsappMessage(from, ["Não consegui obter a resposta do assistente. Por favor, tente novamente."]);
                }
            } else {
                console.error(`[OPENAI_RUN_FAILED] [${from}] Execução ${runId} falhou ou foi cancelada. Status: ${runStatus}`);
                await sendWhatsappMessage(from, [`O processamento com o assistente não foi concluído (status: ${runStatus}). Por favor, tente novamente.`]);
            }
        } catch (error) {
            console.error(`[CONVERSATION_HANDLER_ERROR] [${from}] Erro não tratado no manipulador de conversas:`, safeLogError(error));
            await sendWhatsappMessage(from, ["Ocorreu um erro inesperado ao processar sua mensagem. Tente novamente mais tarde."]);
        }
        res.sendStatus(200);
    } else {
        console.log("[WEBHOOK_UNKNOWN_OBJECT] Objeto desconhecido recebido, não é 'whatsapp_business_account'. Ignorando.");
        res.sendStatus(404); 
    }
});

app.get("/webhook", (req, res) => {
    console.log("[WEBHOOK_VERIFICATION_START] GET /webhook recebido para verificação.");
    const mode = req.query["hub.mode"];
    const token = req.query["hub.verify_token"];
    const challenge = req.query["hub.challenge"];
    if (mode && token) {
        if (mode === "subscribe" && token === VERIFY_TOKEN) {
            console.log("[WEBHOOK_VERIFICATION_SUCCESS] Webhook verificado com sucesso!");
            res.status(200).send(challenge);
        } else {
            console.warn("[WEBHOOK_VERIFICATION_FAILED] Falha na verificação do webhook. Modo ou token inválidos.");
            res.sendStatus(403);
        }
    } else {
        console.warn("[WEBHOOK_VERIFICATION_FAILED] Falha na verificação do webhook. Parâmetros ausentes.");
        res.sendStatus(400);
    }
});

app.get("/", (req, res) => {
    console.log("[HEALTH_CHECK] GET / recebido.");
    res.send("Servidor do webhook WhatsApp-OpenAI está online! Configure seu webhook na Meta para POST em /webhook.");
});

app.use((err, req, res, next) => {
    console.error("[GLOBAL_ERROR_HANDLER] Erro não tratado capturado:", safeLogError(err));
    if (!res.headersSent) {
        res.status(500).send("Ocorreu um erro interno no servidor.");
    }
});

if (require.main === module) { 
    app.listen(PORT, () => {
        console.log(`[SERVER_START] Servidor Node.js escutando na porta ${PORT}`);
    }).on('error', (err) => {
        console.error("[SERVER_START_ERROR] Falha ao iniciar o servidor:", safeLogError(err));
        process.exit(1); 
    });
}

module.exports = app;


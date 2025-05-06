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
    connectTimeout: 10000, // Adicionado timeout de conexão para o Redis
    showFriendlyErrorStack: true // Adicionado para melhor debugging de erros do Redis
});

redis.on("connect", () => console.log("[REDIS] Conectado com sucesso!"));
redis.on("error", (err) => console.error("[REDIS] Erro de conexão:", err));

// --- Configure OpenAI Client ---
const openai = new OpenAI({
    apiKey: OPENAI_API_KEY,
    organization: OPENAI_ORGANIZATION, // Optional
    project: OPENAI_PROJECT,         // Optional
    timeout: 30 * 1000, // Adicionado timeout para chamadas OpenAI (30 segundos)
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
        res.sendStatus(200); // WhatsApp espera 200 OK mesmo que ignoremos
        return;
    }

    const from = messageEntry.from;
    const messageType = messageEntry.type;
    const userStateKey = `whatsapp_user_status:${from}`;
    const userThreadDataKey = `whatsapp_thread_data:${from}`;

    console.log(`[WEBHOOK] [${from}] Notificação recebida. Tipo: ${messageType}. Iniciando processamento...`);
    // Acknowledge receipt immediately to WhatsApp to prevent retries and show as 'delivered'
    // Este sendStatus(200) deve ser a ÚNICA resposta HTTP enviada nesta rota POST.
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
                    // Não envie mensagem de erro aqui, pois já respondemos 200 ao WhatsApp.
                    // O erro já foi logado em getOrCreateThread.
                    return; 
                }

                const aiResponse = await handleOpenAICalls(msg_body, threadId, ASSISTANT_ID, from);
                if (aiResponse) {
                    await sendWhatsappMessage(from, aiResponse);
                } else {
                    console.warn(`[WEBHOOK] [${from}] handleOpenAICalls retornou uma resposta vazia ou indefinida. Nenhuma mensagem enviada para o usuário.`);
                    // Considerar enviar uma mensagem de erro genérica se handleOpenAICalls falhar e não enviar nada.
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
        console.error(`[WEBHOOK] [${from}] Erro NÃO TRATADO no processamento principal do webhook (após res.sendStatus(200)):`, error.message, error.stack);
        // Não tente enviar mensagem de erro aqui via sendWhatsappMessage, pois pode causar loop ou falhar novamente.
        // O erro já está logado para análise.
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
        // Não envie mensagem ao usuário daqui, pois esta função é chamada internamente.
        return null;
    }

    if (createNewThread) {
        try {
            console.log(`[OPENAI] [${from}] Tentando criar novo tópico OpenAI...`);
            const thread = await openai.beta.threads.create();
            threadId = thread.id;
            console.log(`[OPENAI] [${from}] Novo tópico criado: ${threadId}`);
        } catch (error) {
            console.error(`[OPENAI] [${from}] Erro na criação do tópico OpenAI:`, error.message, error.stack ? error.stack.split('\n').slice(0,5).join('\n') : '');
            if (error.response && error.response.data) {
                console.error(`[OPENAI] [${from}] Detalhes do erro da API OpenAI (criação de tópico):`, JSON.stringify(error.response.data, null, 2));
            }
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

        while (runStatus === "queued" || runStatus === "in_progress") { // Removido 'requires_action' do loop de polling direto
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
                console.error(`[OPENAI] [${from}] [Thread: ${threadId}] Nenhuma mensagem de texto da IA encontrada ou conteúdo vazio para a execução ${run.id}. Detalhes das mensagens recuperadas:`, JSON.stringify(allMessages.data.slice(0,5), null, 2));
                await sendWhatsappMessage(from, "Não consegui obter uma resposta formatada corretamente da IA desta vez (mensagem vazia ou não encontrada).");
                return null;
            }
        } else if (runStatus === "requires_action") {
             console.error(`[OPENAI] [${from}] [Thread: ${threadId}] Execução ${run.id} requer ação (Function Calling não implementado).`);
             // Aqui você precisaria implementar a lógica para lidar com tool_calls se o seu assistente os usar.
             // Por enquanto, apenas informamos o usuário.
             await sendWhatsappMessage(from, "A IA precisa realizar uma ação que ainda não está implementada. Por favor, contacte o suporte.");
             return null;
        } else {
            // Inclui 'failed', 'cancelled', 'expired'
            console.error(`[OPENAI] [${from}] [Thread: ${threadId}] Execução ${run.id} finalizada com status problemático: ${runStatus}`);
            await sendWhatsappMessage(from, `Desculpe, houve um problema com a IA (status: ${runStatus}). Tente novamente mais tarde.`);
            return null;
        }
    } catch (error) {
        console.error(`[OPENAI] [${from}] [Thread: ${threadId}] Erro durante chamada à API OpenAI:`, error.message, error.stack ? error.stack.split('\n').slice(0,5).join('\n') : '');
        if (error.response && error.response.data) {
            console.error(`[OPENAI] [${from}] Detalhes do erro da API OpenAI:`, JSON.stringify(error.response.data, null, 2));
        }
        // Evitar enviar mensagens de erro muito técnicas ao usuário
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
        
        const AXIOS_TIMEOUT = 15000; // Timeout de 15 segundos para a requisição Axios

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
            // Log detalhado do erro Axios
            let errorMessage = `[WHATSAPP_SEND] [${to}] Erro ao enviar bloco ${i + 1}/${messageChunks.length}.`;
            if (error.response) {
                // A requisição foi feita e o servidor respondeu com um status code fora do range 2xx
                errorMessage += ` Status: ${error.response.status}. Data: ${JSON.stringify(error.response.data)}.`;
                console.error(errorMessage, `Headers: ${JSON.stringify(error.response.headers)}`);
            } else if (error.request) {
                // A requisição foi feita mas nenhuma resposta foi recebida
                // `error.request` é uma instância de XMLHttpRequest no browser e uma instância de http.ClientRequest em node.js
                errorMessage += ` Nenhuma resposta recebida. Request: ${JSON.stringify(error.request)}.`;
                console.error(errorMessage);
            } else {
                // Algo aconteceu ao configurar a requisição que acionou um erro
                errorMessage += ` Erro na configuração da requisição: ${error.message}.`;
                console.error(errorMessage);
            }
            console.error(`[WHATSAPP_SEND] [${to}] Erro COMPLETO ao tentar enviar bloco ${i + 1}/${messageChunks.length}:`, {
                message: error.message,
                name: error.name,
                code: error.code,
                stack: error.stack ? error.stack.split('\n').slice(0,5).join('\n') : 'No stack available',
                config: error.config ? { url: error.config.url, method: error.config.method, timeout: error.config.timeout, headers: error.config.headers ? 'Present' : 'Missing' } : 'No config available'
            });

            if (error.code === 'ECONNABORTED') {
                console.error(`[WHATSAPP_SEND] [${to}] TIMEOUT (Código: ECONNABORTED) ao enviar bloco ${i + 1}/${messageChunks.length} após ${AXIOS_TIMEOUT}ms. Verifique a conectividade de saída da Vercel para graph.facebook.com ou possíveis restrições da Meta.`);
            } else if (error.code === 'ENOTFOUND' || error.code === 'EAI_AGAIN') {
                 console.error(`[WHATSAPP_SEND] [${to}] ERRO DE DNS/REDE (Código: ${error.code}) ao tentar resolver graph.facebook.com. Verifique a conectividade de rede do servidor.`);
            }
            // Não re-throw o erro aqui para permitir que o loop continue se houver múltiplos chunks (embora seja improvável que funcione)
            // E também porque já respondemos 200 OK ao WhatsApp anteriormente.
            // A falha no envio de uma mensagem não deve travar o resto do processamento do webhook.
            return false; // Indica falha no envio deste chunk
        }
    }
    return true; // Indica sucesso no envio de todos os chunks
}

// Função de tratamento de erro genérico (exemplo, pode ser melhorada)
async function handleGenericError(from, specificMessage = "Ocorreu um erro inesperado ao processar sua solicitação.") {
    console.error(`[ERROR_HANDLER] [${from}] Erro genérico. Mensagem: ${specificMessage}`);
    // Não tente enviar mensagem de erro ao usuário aqui, pois pode estar dentro de um catch de sendWhatsappMessage
    // ou a conexão com o WhatsApp pode ser o problema.
}

async function handleOpenAIError(error, from, specificMessage = "Ocorreu um erro ao comunicar com a IA.") {
    console.error(`[ERROR_HANDLER] [${from}] Erro OpenAI. Mensagem: ${specificMessage}`, error.message);
    // Não tente enviar mensagem de erro ao usuário aqui.
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

// Graceful Shutdown (exemplo básico)
process.on('SIGTERM', () => {
  console.log('[SERVER] Sinal SIGTERM recebido. Fechando o servidor HTTP.');
  redis.quit(() => {
      console.log('[REDIS] Conexão Redis fechada.');
      process.exit(0);
  });
});

process.on('SIGINT', () => {
  console.log('[SERVER] Sinal SIGINT recebido. Fechando o servidor HTTP.');
  redis.quit(() => {
      console.log('[REDIS] Conexão Redis fechada.');
      process.exit(0);
  });
});


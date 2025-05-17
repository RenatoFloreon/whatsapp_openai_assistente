require("dotenv").config();
const express = require("express");
const crypto = require("crypto");
const OpenAI = require("openai");
const Redis = require("ioredis");
const fetch = require("node-fetch");
const cheerio = require("cheerio");
const axios = require("axios");

const app = express();
app.use(express.json());

// Configurações básicas
const PORT = process.env.PORT || 3000;
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const REDIS_URL = process.env.REDIS_URL;
const WHATSAPP_PHONE_ID = process.env.WHATSAPP_PHONE_ID;
const KOMMO_API_KEY = process.env.KOMMO_API_KEY;
const KOMMO_ACCOUNT_ID = process.env.KOMMO_ACCOUNT_ID;

// Configurações de timeout
const FETCH_TIMEOUT_MS = parseInt(process.env.FETCH_TIMEOUT_MS) || 20000;
const OPENAI_TIMEOUT_MS = parseInt(process.env.OPENAI_TIMEOUT_MS) || 30000;
const REDIS_TLS_REJECT_UNAUTHORIZED = process.env.REDIS_TLS_REJECT_UNAUTHORIZED !== 'false'; // Padrão é true

// Inicialização e logs
console.log("[INDEX_JS_TOP_LEVEL] Execução do script iniciada em", new Date().toISOString(), "Servidor escutando na porta", PORT);
console.log(`[INDEX_JS_TOP_LEVEL] REDIS_URL: ${REDIS_URL ? 'Definida' : 'NÃO DEFINIDA'}`);
console.log(`[INDEX_JS_TOP_LEVEL] REDIS_TLS_REJECT_UNAUTHORIZED: ${REDIS_TLS_REJECT_UNAUTHORIZED}`);
console.log(`[INDEX_JS_TOP_LEVEL] OPENAI_API_KEY: ${OPENAI_API_KEY ? 'Definida' : 'NÃO DEFINIDA'}`);
console.log(`[INDEX_JS_TOP_LEVEL] KOMMO_API_KEY: ${KOMMO_API_KEY ? 'Definida' : 'NÃO DEFINIDA'}`);

// Inicialização da OpenAI
let openai;
if (OPENAI_API_KEY) {
    openai = new OpenAI({ apiKey: OPENAI_API_KEY });
    console.log("[INDEX_JS_TOP_LEVEL] Instância OpenAI criada com sucesso.");
} else {
    console.error("[INDEX_JS_TOP_LEVEL_ERROR] OPENAI_API_KEY não está definida. A funcionalidade da OpenAI será desativada.");
}

// Inicialização do Redis
let redis;
if (REDIS_URL) {
    try {
        console.log(`[REDIS_INIT_ATTEMPT] Tentando inicializar o Redis com a URL: ${REDIS_URL.substring(0, REDIS_URL.indexOf("://") + 3)}... e REDIS_TLS_REJECT_UNAUTHORIZED: ${REDIS_TLS_REJECT_UNAUTHORIZED}`);
        
        const redisOptions = {
            maxRetriesPerRequest: 3,
            connectTimeout: 15000,
            retryStrategy(times) {
                const delay = Math.min(times * 200, 2000);
                console.log(`[REDIS_RETRY_STRATEGY] Tentativa de reconexão Redis #${times}. Próxima tentativa em ${delay}ms.`);
                return delay;
            }
        };

        if (REDIS_URL.startsWith("rediss://")) {
            redisOptions.tls = {
                rejectUnauthorized: REDIS_TLS_REJECT_UNAUTHORIZED,
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

// Função para logar erros de forma segura
function safeLogError(error, additionalInfo = {}) {
    const errorDetails = {
        message: error.message,
        name: error.name,
        stack: error.stack ? error.stack.split("\n").slice(0, 5).join("\n") : "No stack trace",
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

// Função para enviar mensagens WhatsApp
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

// Função para extrair dados públicos do Instagram
async function scrapeInstagramProfile(username) {
    console.log(`[INSTAGRAM_SCRAPE_ATTEMPT] Tentando extrair dados do perfil: ${username}`);
    try {
        // Removendo @ se existir
        username = username.replace('@', '');
        
        const response = await axios.get(`https://www.instagram.com/${username}/`, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
                'Accept-Language': 'en-US,en;q=0.5',
                'Connection': 'keep-alive',
                'Upgrade-Insecure-Requests': '1',
                'Cache-Control': 'max-age=0'
            },
            timeout: 10000
        });

        const $ = cheerio.load(response.data);
        
        // Extrair dados básicos do perfil
        const profileData = {
            username: username,
            fullName: '',
            bio: '',
            followersCount: 0,
            postsCount: 0,
            isBusinessAccount: false,
            businessCategory: '',
            recentPosts: []
        };

        // Extrair metadados do perfil
        const metaTags = $('meta');
        metaTags.each((i, el) => {
            const property = $(el).attr('property');
            if (property === 'og:title') {
                profileData.fullName = $(el).attr('content').split(' (')[0];
            }
            if (property === 'og:description') {
                const content = $(el).attr('content');
                if (content.includes('Followers') && content.includes('Following')) {
                    profileData.bio = content.split('Followers')[0].trim();
                    
                    // Tentar extrair contagem de seguidores
                    const followersMatch = content.match(/(\d+(?:,\d+)*) Followers/);
                    if (followersMatch) {
                        profileData.followersCount = parseInt(followersMatch[1].replace(/,/g, ''));
                    }
                    
                    // Tentar extrair contagem de posts
                    const postsMatch = content.match(/(\d+(?:,\d+)*) Posts/);
                    if (postsMatch) {
                        profileData.postsCount = parseInt(postsMatch[1].replace(/,/g, ''));
                    }
                }
            }
        });

        // Verificar se é uma conta comercial
        if ($('a:contains("Contact")').length > 0) {
            profileData.isBusinessAccount = true;
        }

        // Tentar extrair categoria de negócio
        const categoryElement = $('div:contains("·")').first();
        if (categoryElement.length > 0) {
            const categoryText = categoryElement.text();
            if (categoryText.includes('·')) {
                profileData.businessCategory = categoryText.split('·')[1].trim();
            }
        }

        console.log(`[INSTAGRAM_SCRAPE_SUCCESS] Dados extraídos com sucesso para: ${username}`);
        return profileData;
    } catch (error) {
        console.error(`[INSTAGRAM_SCRAPE_ERROR] Erro ao extrair dados do perfil ${username}:`, safeLogError(error));
        return {
            username: username,
            error: "Não foi possível extrair dados do perfil"
        };
    }
}

// Função para gerar a Carta de Consciência
async function generateConscienciaLetter(profileData, userName) {
    console.log(`[OPENAI_LETTER_GENERATION_ATTEMPT] Gerando Carta de Consciência para: ${userName}`);
    
    try {
        // Preparar o prompt para a OpenAI
        const prompt = `
        Você é o Conselheiro da Consciênc.IA, um assistente virtual especial criado para o evento MAPA DO LUCRO no Coworking Ikigai.
        
        Sua tarefa é gerar uma "Carta de Consciência" personalizada para ${userName}, com base nos dados do perfil de Instagram @${profileData.username}.
        
        Dados do perfil:
        - Nome: ${profileData.fullName || userName}
        - Bio: "${profileData.bio || 'Não disponível'}"
        - Seguidores: ${profileData.followersCount || 'Não disponível'}
        - Número de posts: ${profileData.postsCount || 'Não disponível'}
        - Conta comercial: ${profileData.isBusinessAccount ? 'Sim' : 'Não'}
        - Categoria de negócio: ${profileData.businessCategory || 'Não disponível'}
        
        A Carta de Consciência deve ter quatro seções:
        
        1. PERFIL COMPORTAMENTAL (INSIGHT DE CONSCIÊNCIA):
        Uma análise personalizada do comportamento e "pegada digital" do participante. Identifique traços de personalidade empreendedora, interesses e estilo de comunicação com base nos dados disponíveis. Seja respeitoso e construtivo, levando o participante a se enxergar de fora por um momento. Relacione com o conceito Ikigai (equilíbrio entre paixão, missão, vocação e profissão).
        
        2. DICAS PRÁTICAS DE USO DE IA NOS NEGÓCIOS:
        Ofereça 2-3 dicas sob medida de como esta pessoa pode alavancar Inteligência Artificial em seu negócio ou rotina profissional. Considere o ramo ou interesse detectado. Por exemplo, se for do setor de varejo, sugira ferramentas de IA para análise de tendências; se for prestador de serviço, indique uso de IA para automação de marketing. Seja específico e prático.
        
        3. PÍLULA DE INSPIRAÇÃO (POESIA INDIVIDUALIZADA):
        Crie uma breve poesia personalizada (4-6 linhas) para o participante, baseada em valores que a pessoa transparece, nome ou significado da marca, cidade natal, etc. Use metáforas relacionadas ao contexto da pessoa.
        
        4. RECOMENDAÇÕES ALINHADAS:
        Conecte os insights do perfil e dicas de IA com os pilares do Método S.I.M. (ambiente, mindset, vendas, felicidade), com o conceito Ikigai e com o propósito do evento Mapa do Lucro. Dê recomendações motivacionais e estratégicas que reafirmem esses conceitos aplicados ao contexto do indivíduo.
        
        Importante:
        - Mantenha um tom inspirador, positivo e profissional
        - Seja específico e personalizado, evitando generalizações
        - Limite cada seção a 1-2 parágrafos para manter a carta concisa
        - Mencione o Programa Consciênc.IA de Renato Hilel e Nuno Arcanjo na conclusão
        - Assine como "Conselheiro da Consciênc.IA"
        `;
        
        // Gerar a carta usando a OpenAI
        const completion = await openai.chat.completions.create({
            model: "gpt-4",
            messages: [
                { role: "system", content: prompt },
                { role: "user", content: "Gere uma Carta de Consciência personalizada." }
            ],
            max_tokens: 1500,
            temperature: 0.7,
        });
        
        const letter = completion.choices[0].message.content;
        console.log(`[OPENAI_LETTER_GENERATION_SUCCESS] Carta gerada com sucesso para: ${userName}`);
        
        return letter;
    } catch (error) {
        console.error(`[OPENAI_LETTER_GENERATION_ERROR] Erro ao gerar carta para ${userName}:`, safeLogError(error));
        return "Não foi possível gerar sua Carta de Consciência personalizada. Por favor, tente novamente mais tarde.";
    }
}

// Função para adicionar lead ao Kommo CRM
async function addLeadToKommo(userData) {
    if (!KOMMO_API_KEY || !KOMMO_ACCOUNT_ID) {
        console.log("[KOMMO_INFO] KOMMO_API_KEY ou KOMMO_ACCOUNT_ID não definidos. Pulando integração com Kommo.");
        return false;
    }
    
    console.log(`[KOMMO_ADD_LEAD_ATTEMPT] Adicionando lead ao Kommo: ${userData.name}`);
    
    try {
        const contactData = {
            name: userData.name,
            custom_fields_values: [
                {
                    field_id: 1, // ID do campo de telefone no Kommo
                    values: [{ value: userData.phone }]
                }
            ]
        };
        
        if (userData.email) {
            contactData.custom_fields_values.push({
                field_id: 2, // ID do campo de email no Kommo
                values: [{ value: userData.email }]
            });
        }
        
        if (userData.instagram) {
            contactData.custom_fields_values.push({
                field_id: 3, // ID do campo de Instagram no Kommo
                values: [{ value: userData.instagram }]
            });
        }
        
        // Adicionar contato
        const contactResponse = await axios.post(
            `https://${KOMMO_ACCOUNT_ID}.kommo.com/api/v4/contacts`,
            { add: [contactData] },
            {
                headers: {
                    'Authorization': `Bearer ${KOMMO_API_KEY}`,
                    'Content-Type': 'application/json'
                }
            }
        );
        
        if (!contactResponse.data || !contactResponse.data._embedded || !contactResponse.data._embedded.contacts) {
            console.error(`[KOMMO_ERROR] Resposta inválida ao adicionar contato: ${JSON.stringify(contactResponse.data)}`);
            return false;
        }
        
        const contactId = contactResponse.data._embedded.contacts[0].id;
        
        // Criar lead
        const leadData = {
            name: `Lead do evento MAPA DO LUCRO - ${userData.name}`,
            price: 0,
            status_id: 142, // ID do status "Novo Lead" no Kommo
            _embedded: {
                contacts: [{ id: contactId }]
            }
        };
        
        const leadResponse = await axios.post(
            `https://${KOMMO_ACCOUNT_ID}.kommo.com/api/v4/leads`,
            { add: [leadData] },
            {
                headers: {
                    'Authorization': `Bearer ${KOMMO_API_KEY}`,
                    'Content-Type': 'application/json'
                }
            }
        );
        
        if (!leadResponse.data || !leadResponse.data._embedded || !leadResponse.data._embedded.leads) {
            console.error(`[KOMMO_ERROR] Resposta inválida ao adicionar lead: ${JSON.stringify(leadResponse.data)}`);
            return false;
        }
        
        console.log(`[KOMMO_SUCCESS] Lead adicionado com sucesso para: ${userData.name}`);
        return true;
    } catch (error) {
        console.error(`[KOMMO_ERROR] Erro ao adicionar lead para ${userData.name}:`, safeLogError(error));
        return false;
    }
}

// Função para dividir mensagens longas
function splitMessage(text, maxLength = 1000) {
    if (text.length <= maxLength) return [text];
    
    const chunks = [];
    let currentChunk = "";
    const paragraphs = text.split("\n\n");
    
    for (const paragraph of paragraphs) {
        if (currentChunk.length + paragraph.length + 2 <= maxLength) {
            currentChunk += (currentChunk ? "\n\n" : "") + paragraph;
        } else {
            if (currentChunk) chunks.push(currentChunk);
            
            if (paragraph.length > maxLength) {
                // Se o parágrafo for maior que o tamanho máximo, divida-o em sentenças
                const sentences = paragraph.split(/(?<=\.|\?|\!) /);
                currentChunk = "";
                
                for (const sentence of sentences) {
                    if (currentChunk.length + sentence.length + 1 <= maxLength) {
                        currentChunk += (currentChunk ? " " : "") + sentence;
                    } else {
                        if (currentChunk) chunks.push(currentChunk);
                        
                        if (sentence.length > maxLength) {
                            // Se a sentença for maior que o tamanho máximo, divida-a em partes
                            let remainingSentence = sentence;
                            while (remainingSentence.length > 0) {
                                const chunk = remainingSentence.substring(0, maxLength);
                                chunks.push(chunk);
                                remainingSentence = remainingSentence.substring(maxLength);
                            }
                            currentChunk = "";
                        } else {
                            currentChunk = sentence;
                        }
                    }
                }
            } else {
                currentChunk = paragraph;
            }
        }
    }
    
    if (currentChunk) chunks.push(currentChunk);
    return chunks;
}

// Rotas da API
app.get("/webhook", (req, res) => {
    console.log("[WEBHOOK_VERIFICATION_HANDLER_START]", req.method, req.url, "Verificação de webhook recebida.");
    
    const mode = req.query["hub.mode"];
    const token = req.query["hub.verify_token"];
    const challenge = req.query["hub.challenge"];
    
    if (mode && token) {
        if (mode === "subscribe" && token === VERIFY_TOKEN) {
            console.log("[WEBHOOK_VERIFIED] Webhook verificado com sucesso!");
            res.status(200).send(challenge);
        } else {
            console.error("[WEBHOOK_VERIFICATION_FAILED] Falha na verificação do webhook. Modo ou token inválidos.");
            res.sendStatus(403);
        }
    } else {
        console.error("[WEBHOOK_VERIFICATION_MISSING_PARAMS] Parâmetros 'hub.mode' ou 'hub.verify_token' ausentes.");
        res.sendStatus(400);
    }
});

app.post("/webhook", async (req, res) => {
    console.log("[WEBHOOK_HANDLER_START] Webhook recebido.");
    
    try {
        const body = req.body;
        
        if (!body || !body.object || body.object !== "whatsapp_business_account") {
            console.error("[WEBHOOK_INVALID_REQUEST] Requisição inválida recebida:", JSON.stringify(body));
            return res.sendStatus(400);
        }
        
        if (!body.entry || !body.entry.length) {
            console.error("[WEBHOOK_NO_ENTRIES] Nenhuma entrada encontrada na requisição:", JSON.stringify(body));
            return res.sendStatus(400);
        }
        
        console.log("[WEBHOOK_BODY] Corpo completo da solicitação (primeiros 500 caracteres):", JSON.stringify(body).substring(0, 500));
        
        for (const entry of body.entry) {
            if (!entry.changes || !entry.changes.length) continue;
            
            for (const change of entry.changes) {
                if (!change.value || !change.value.messages || !change.value.messages.length) continue;
                
                for (const message of change.value.messages) {
                    if (message.type !== "text" || !message.from) continue;
                    
                    const userPhoneNumber = message.from;
                    const messageText = message.text.body;
                    
                    console.log(`[WEBHOOK_MESSAGE_RECEIVED] Mensagem recebida de ${userPhoneNumber}: "${messageText}"`);
                    
                    // Verificar se o usuário já existe no Redis
                    let userData = null;
                    const userKey = `evento:user_data:${userPhoneNumber}`;
                    
                    if (redis) {
                        try {
                            console.log(`[REDIS_GET_ATTEMPT] Tentando obter dados do usuário: ${userPhoneNumber}`);
                            const userDataStr = await redis.get(userKey);
                            
                            if (userDataStr) {
                                userData = JSON.parse(userDataStr);
                                console.log(`[REDIS_GET_SUCCESS] Dados do usuário encontrados: ${userPhoneNumber}, estado: ${userData.state}`);
                            } else {
                                console.log(`[REDIS_GET_NOT_FOUND] Usuário não encontrado: ${userPhoneNumber}`);
                            }
                        } catch (error) {
                            console.error(`[REDIS_GET_ERROR] Erro ao obter dados do usuário ${userPhoneNumber}:`, safeLogError(error));
                        }
                    }
                    
                    // Se o usuário não existe, criar novo registro
                    if (!userData) {
                        userData = {
                            phone: userPhoneNumber,
                            state: "WELCOME",
                            startTime: Date.now(),
                            completed: false
                        };
                        
                        // Enviar mensagem de boas-vindas
                        const welcomeMessage = `Olá! 👋 Bem-vindo(a) ao *Conselheiro da Consciênc.IA* do evento MAPA DO LUCRO no Coworking Ikigai!

Sou um assistente virtual especial criado para gerar sua *Carta de Consciência* personalizada - uma análise única baseada no seu perfil digital que revelará insights valiosos sobre seu comportamento empreendedor e recomendações práticas para uso de IA em seus negócios.

Para começar, preciso conhecer você melhor. 

Por favor, me diga seu nome completo:`;
                        
                        await sendWhatsappMessage(userPhoneNumber, [welcomeMessage]);
                        
                        // Salvar dados do usuário no Redis
                        if (redis) {
                            try {
                                console.log(`[REDIS_SET_ATTEMPT] Tentando salvar dados do novo usuário: ${userPhoneNumber}`);
                                await redis.set(userKey, JSON.stringify(userData));
                                console.log(`[REDIS_SET_SUCCESS] Dados do novo usuário salvos: ${userPhoneNumber}`);
                            } catch (error) {
                                console.error(`[REDIS_SET_ERROR] Erro ao salvar dados do usuário ${userPhoneNumber}:`, safeLogError(error));
                            }
                        }
                        
                        continue;
                    }
                    
                    // Processar a mensagem com base no estado atual do usuário
                    switch (userData.state) {
                        case "WELCOME":
                            // Usuário está enviando o nome
                            userData.name = messageText.trim();
                            userData.state = "ASK_EMAIL";
                            
                            await sendWhatsappMessage(userPhoneNumber, [`Obrigado, ${userData.name}! 😊

Para que possamos enviar materiais adicionais e manter contato após o evento, por favor, me informe seu e-mail:

(Se preferir não compartilhar seu e-mail agora, pode digitar "pular" para continuar)`]);
                            break;
                            
                        case "ASK_EMAIL":
                            // Usuário está enviando o email
                            if (messageText.toLowerCase() !== "pular") {
                                userData.email = messageText.trim();
                            }
                            
                            userData.state = "ASK_INSTAGRAM";
                            
                            await sendWhatsappMessage(userPhoneNumber, [`Perfeito! Agora, para que eu possa gerar sua Carta de Consciência personalizada, preciso analisar seu perfil digital.

Por favor, me informe seu nome de usuário no Instagram (com ou sem @):

Exemplo: @consciencia.ia`]);
                            break;
                            
                        case "ASK_INSTAGRAM":
                            // Usuário está enviando o perfil do Instagram
                            userData.instagram = messageText.trim().replace(/^@/, '');
                            userData.state = "GENERATING_LETTER";
                            
                            await sendWhatsappMessage(userPhoneNumber, [`Obrigado! Estou processando sua solicitação, aguarde um momento...

Vou analisar seu perfil @${userData.instagram} e gerar sua Carta de Consciência personalizada. Isso pode levar alguns instantes.`]);
                            
                            // Extrair dados do perfil do Instagram
                            const profileData = await scrapeInstagramProfile(userData.instagram);
                            
                            // Gerar a Carta de Consciência
                            const letter = await generateConscienciaLetter(profileData, userData.name);
                            
                            // Dividir a carta em blocos para envio
                            const letterBlocks = splitMessage(letter);
                            
                            // Enviar a carta
                            await sendWhatsappMessage(userPhoneNumber, letterBlocks);
                            
                            // Enviar mensagem final
                            const finalMessage = `Espero que tenha gostado da sua Carta de Consciência personalizada! 🌟

Para saber mais sobre como a IA pode transformar seu negócio e sua vida, conheça o *Programa Consciênc.IA* de Renato Hilel e Nuno Arcanjo.

Visite: https://consciencia.ia

Aproveite o evento MAPA DO LUCRO e não deixe de conversar pessoalmente com os criadores do programa!`;
                            
                            await sendWhatsappMessage(userPhoneNumber, [finalMessage]);
                            
                            // Atualizar estado do usuário
                            userData.state = "COMPLETED";
                            userData.completed = true;
                            userData.completionTime = Date.now();
                            
                            // Adicionar lead ao Kommo CRM
                            if (KOMMO_API_KEY && KOMMO_ACCOUNT_ID) {
                                await addLeadToKommo(userData);
                            }
                            
                            break;
                            
                        case "COMPLETED":
                            // Usuário já completou o fluxo, enviar mensagem de retorno
                            await sendWhatsappMessage(userPhoneNumber, [`Olá novamente, ${userData.name}! 👋

Você já recebeu sua Carta de Consciência personalizada. Se deseja mais informações sobre o Programa Consciênc.IA, visite:

https://consciencia.ia

Se tiver alguma dúvida específica, pode me perguntar e tentarei ajudar!`]);
                            break;
                            
                        default:
                            // Estado desconhecido, resetar para o início
                            userData.state = "WELCOME";
                            
                            await sendWhatsappMessage(userPhoneNumber, [`Desculpe, ocorreu um erro no processamento. Vamos recomeçar.

Por favor, me diga seu nome completo:`]);
                            break;
                    }
                    
                    // Salvar dados atualizados do usuário no Redis
                    if (redis) {
                        try {
                            console.log(`[REDIS_SET_ATTEMPT] Tentando atualizar dados do usuário: ${userPhoneNumber}, estado: ${userData.state}`);
                            await redis.set(userKey, JSON.stringify(userData));
                            console.log(`[REDIS_SET_SUCCESS] Dados do usuário atualizados: ${userPhoneNumber}`);
                        } catch (error) {
                            console.error(`[REDIS_SET_ERROR] Erro ao atualizar dados do usuário ${userPhoneNumber}:`, safeLogError(error));
                        }
                    }
                }
            }
        }
        
        res.sendStatus(200);
    } catch (error) {
        console.error("[WEBHOOK_ERROR] Erro ao processar webhook:", safeLogError(error));
        res.sendStatus(500);
    }
});

// Rota de verificação de saúde
app.get("/", (req, res) => {
    console.log("[HEALTH_CHECK] GET / recebido.");
    res.send("Servidor do assistente WhatsApp-OpenAI está ativo e a escutar!");
});

// Rota de administração
app.get("/admin", (req, res) => {
    // Esta rota será implementada pelo painel administrativo Flask
    res.send("Painel administrativo disponível em um servidor separado.");
});

// Iniciar o servidor
if (require.main === module) {
    app.listen(PORT, () => {
        console.log(`[SERVER_START] Servidor Node.js escutando na porta ${PORT}`);
    }).on("error", (err) => {
        console.error("[SERVER_START_ERROR] Falha ao iniciar o servidor:", safeLogError(err));
        process.exit(1);
    });
}

module.exports = app;

# API WhatsApp + Assistente OpenAI (GPT)

Este projeto integra a API Cloud do WhatsApp Business com a API Assistants da OpenAI para fornecer um assistente virtual inteligente que interage com usuários via WhatsApp.

## Funcionalidades Principais

*   **Recepção de Mensagens do WhatsApp:** Utiliza um endpoint de webhook para receber mensagens de usuários.
*   **Fluxo de Boas-Vindas:** Envia mensagens iniciais para novos usuários ou quando o evento `request_welcome` é recebido.
*   **Gerenciamento de Estado da Conversa:** Utiliza Redis para persistir o estado do usuário (se está aguardando o prompt inicial ou em conversação) e os dados do Thread da OpenAI.
*   **Integração com OpenAI Assistants API:**
    *   Cria e gerencia Threads de conversa para cada usuário.
    *   Adiciona mensagens do usuário ao respectivo Thread.
    *   Executa o Assistente OpenAI configurado (`ASSISTANT_ID`) para processar as mensagens.
    *   Realiza polling para verificar a conclusão do processamento pelo Assistente.
    *   Extrai e envia as respostas do Assistente de volta ao usuário no WhatsApp.
*   **Expiração de Threads:** Threads no Redis e a lógica de interação são configurados para expirar após 12 horas de inatividade, iniciando uma nova sessão de thread se o usuário retornar.
*   **Mensagem de Processamento:** Informa ao usuário que sua solicitação está sendo processada pela IA.
*   **Divisão de Mensagens Longas:** Respostas da OpenAI que excedem o limite de caracteres do WhatsApp são automaticamente divididas em múltiplas mensagens.
*   **Tratamento de Erros Robusto:** Inclui tratamento para erros comuns da API do WhatsApp e da OpenAI (ex: rate limits), com mensagens informativas para o usuário e logging detalhado.
*   **Configuração Flexível:** Utiliza variáveis de ambiente para todas as chaves, tokens e configurações importantes.
*   **Pronto para Deploy na Vercel:** Estruturado para fácil deploy em plataformas serverless como a Vercel, utilizando Redis (como Vercel KV ou Upstash) para persistência.

## Estrutura do Projeto

```
whatsapp_openai_app/
├── node_modules/
├── .env             # Arquivo de variáveis de ambiente (NÃO FAÇA COMMIT DESTE ARQUIVO COM CHAVES REAIS)
├── index.js         # Lógica principal da aplicação (servidor Express, webhooks, integrações)
├── package.json     # Dependências e scripts do projeto
└── package-lock.json
```

## Configuração

1.  **Pré-requisitos:**
    *   Node.js (versão recomendada: 18.x ou superior)
    *   Conta de Desenvolvedor da Meta (Facebook) com um App configurado para a API Cloud do WhatsApp Business.
    *   Número de telefone registrado e configurado no App da Meta.
    *   Conta na OpenAI com acesso à API e um `ASSISTANT_ID` criado.
    *   Serviço Redis acessível (ex: Vercel KV, Upstash, ou Redis local para desenvolvimento).

2.  **Clonar o Repositório (se aplicável) ou usar os arquivos fornecidos.**

3.  **Instalar Dependências:**
    ```bash
    cd whatsapp_openai_app
    npm install
    ```

4.  **Configurar Variáveis de Ambiente:**
    Crie um arquivo `.env` na raiz do diretório `whatsapp_openai_app` com o seguinte conteúdo, substituindo os valores pelos seus próprios:

    ```env
    # === Credenciais do WhatsApp (Meta Developers) ===
    # Token de Acesso Permanente da API Cloud do WhatsApp
    WHATSAPP_TOKEN=SEU_WHATSAPP_TOKEN_DE_ACESSO
    # ID do seu Número de Telefone Comercial do WhatsApp
    WHATSAPP_PHONE_ID=SEU_ID_DO_NUMERO_DE_TELEFONE_WHATSAPP
    # Token de Verificação do Webhook (você define este valor)
    VERIFY_TOKEN=SEU_TOKEN_DE_VERIFICACAO_SECRETO

    # === Credenciais da OpenAI ===
    # Sua Chave de API da OpenAI
    OPENAI_API_KEY=sk-SUA_CHAVE_DE_API_OPENAI
    # ID do seu Assistente OpenAI configurado
    ASSISTANT_ID=asst_SEU_ASSISTANT_ID
    # Opcional: ID da Organização OpenAI (se aplicável)
    # OPENAI_ORGANIZATION=org-SUA_ORGANIZACAO_ID
    # Opcional: ID do Projeto OpenAI (se aplicável)
    # OPENAI_PROJECT=proj_SEU_PROJETO_ID

    # === Configuração do Redis ===
    # URL de conexão completa do seu serviço Redis
    # Exemplo Vercel KV: redis://default:SENHA@HOST:PORT
    # Exemplo Upstash: rediss://default:SENHA@HOST:PORT (note o 'rediss' para TLS)
    # Exemplo Local: redis://localhost:6379
    REDIS_URL=SUA_REDIS_CONNECTION_URL

    # === Configurações da Aplicação ===
    # Porta para execução local (não usada diretamente pela Vercel em produção)
    PORT=3000
    # Comprimento máximo de uma mensagem do WhatsApp antes de ser dividida
    WHATSAPP_MAX_MESSAGE_LENGTH=4000

    # === Mensagens Personalizáveis (Opcional) ===
    # Se não definidas, mensagens padrão no código serão usadas.
    WELCOME_MESSAGE_1="Olá! Sou seu assistente virtual. Bem-vindo(a)!"
    WELCOME_MESSAGE_2="Como posso te ajudar hoje?"
    PROCESSING_MESSAGE="Estou consultando a inteligência artificial, um momento..."
    ```

    **Importante:** Nunca faça commit do seu arquivo `.env` com credenciais reais para repositórios públicos.

## Execução Local (para Desenvolvimento e Testes)

1.  Certifique-se de que seu Redis está acessível (localmente ou na nuvem).
2.  Inicie o servidor:
    ```bash
    npm start
    ```
    (Assumindo que você adicione `"start": "node index.js"` aos scripts no `package.json`)
    Ou diretamente:
    ```bash
    node index.js
    ```
3.  O servidor estará rodando em `http://localhost:PORT` (ex: `http://localhost:3000`).
4.  **Configurar Webhook no App da Meta:**
    *   Você precisará de uma URL pública para o seu webhook. Durante o desenvolvimento local, ferramentas como `ngrok` podem ser usadas para expor seu servidor local à internet (`ngrok http 3000`).
    *   No painel do seu App da Meta, vá para a seção WhatsApp > Configuração.
    *   Configure o Webhook:
        *   **URL de Callback:** Sua URL pública seguida de `/webhook` (ex: `https://SUA_URL_PUBLICA.ngrok.io/webhook`).
        *   **Token de Verificação:** O mesmo valor que você definiu para `VERIFY_TOKEN` no seu arquivo `.env`.
    *   Assine os eventos de mensagem. No mínimo, você precisará de `messages`.

## Deploy na Vercel

1.  **Crie uma conta na Vercel** (se ainda não tiver).
2.  **Conecte seu Repositório GitHub (ou outro provedor Git):**
    *   Faça o deploy do seu projeto a partir do seu repositório Git.
3.  **Configuração do Projeto na Vercel:**
    *   **Framework Preset:** Selecione `Node.js`.
    *   **Build Command:** Geralmente pode ser deixado em branco ou `npm install` se necessário.
    *   **Output Directory:** Geralmente pode ser deixado em branco.
    *   **Install Command:** `npm install`.
    *   **Development Command:** `node index.js` (para referência, não usado para deploy de produção).
4.  **Configurar Variáveis de Ambiente na Vercel:**
    *   No painel do seu projeto na Vercel, vá para Settings > Environment Variables.
    *   Adicione todas as variáveis de ambiente definidas no seu arquivo `.env` (WHATSAPP_TOKEN, WHATSAPP_PHONE_ID, VERIFY_TOKEN, OPENAI_API_KEY, ASSISTANT_ID, REDIS_URL, WHATSAPP_MAX_MESSAGE_LENGTH, etc.).
    *   **Importante:** Para `REDIS_URL`, use a URL de conexão do seu serviço Redis (ex: Vercel KV, Upstash). Se estiver usando Vercel KV, a Vercel pode injetar a variável automaticamente ou fornecer a string de conexão.
5.  **Faça o Deploy.**
6.  **Atualizar URL do Webhook na Meta:**
    *   Após o deploy, a Vercel fornecerá uma URL pública para sua aplicação (ex: `https://SEU_PROJETO.vercel.app`).
    *   Atualize a **URL de Callback** do Webhook no seu App da Meta para `https://SEU_PROJETO.vercel.app/webhook`.

## Fluxo da Aplicação

1.  **Configuração do Webhook:** A Meta envia uma requisição GET para `/webhook` com `hub.mode=subscribe` e `hub.verify_token`. O servidor valida o token e responde com `hub.challenge`.
2.  **Nova Mensagem do Usuário / Evento `request_welcome`:**
    *   O WhatsApp envia uma notificação POST para `/webhook`.
    *   O servidor responde imediatamente com `200 OK` para o WhatsApp.
    *   Se for `request_welcome` ou a primeira mensagem de um usuário (sem estado no Redis), as duas mensagens de boas-vindas são enviadas e o estado do usuário é definido como `AWAITING_INITIAL_PROMPT` no Redis.
3.  **Usuário Envia o Prompt (após boas-vindas):**
    *   O servidor recebe a mensagem de texto.
    *   Envia a `PROCESSING_MESSAGE` para o usuário.
    *   O estado do usuário é atualizado para `CONVERSING`.
    *   Um Thread da OpenAI é obtido ou criado (com base no `lastInteractionTimestamp` no Redis, expira em 12h).
    *   A mensagem do usuário é adicionada ao Thread.
4.  **Interação com OpenAI:**
    *   Um "Run" é criado para o `ASSISTANT_ID` processar o Thread.
    *   O servidor faz polling para verificar o status do Run.
5.  **Resposta da OpenAI:**
    *   Quando o Run é concluído, as mensagens do Assistente são recuperadas.
    *   A resposta é enviada ao usuário via WhatsApp (dividida em partes, se necessário).
    *   O `lastInteractionTimestamp` do Thread é atualizado no Redis.

## Considerações Adicionais

*   **Segurança:** Mantenha suas chaves de API e tokens seguros. Não os exponha no código-fonte ou em repositórios públicos.
*   **Rate Limits:** Tanto a API do WhatsApp quanto a da OpenAI possuem limites de taxa. O código inclui tratamento básico para erro 429 (Too Many Requests), mas para alto volume, estratégias mais robustas (como backoff exponencial, filas) podem ser necessárias.
*   **Logging:** A aplicação inclui logging básico no console. Para produção, considere integrar com um serviço de logging mais robusto.
*   **Escalabilidade:** A arquitetura serverless na Vercel com Redis é escalável. Otimizações no uso da API da OpenAI (ex: streaming de respostas, se suportado pelo Assistant e desejado) podem melhorar a percepção de velocidade.
*   **Base de Conhecimento:** Para usar uma base de conhecimento específica, você precisará configurar seu Assistente na plataforma OpenAI para usar Ferramentas de Recuperação (Retrieval) e fazer upload dos seus arquivos de conhecimento.

Este README fornece um guia completo para configurar, executar e fazer o deploy da sua integração WhatsApp + OpenAI.


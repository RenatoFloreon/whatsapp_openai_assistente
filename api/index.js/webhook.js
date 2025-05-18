module.exports = (req, res) => {
  if (req.method === 'GET') {
    const VERIFY_TOKEN = process.env.VERIFY_TOKEN;

    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    if (mode && token && mode === 'subscribe' && token === VERIFY_TOKEN) {
      console.log('[WEBHOOK] Verificado com sucesso!');
      res.status(200).send(challenge);
    } else {
      console.warn('[WEBHOOK] Falha na verificação.');
      res.sendStatus(403);
    }
  }

  if (req.method === 'POST') {
    const body = req.body;
    console.log('[WEBHOOK] Evento recebido:', JSON.stringify(body, null, 2));

    // TODO: encaminhar para processamento da IA

    res.status(200).send('EVENT_RECEIVED');
  }
};

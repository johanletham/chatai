      headers: {
        Authorization: `Bearer ${process.env.META_ACCESS_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to,
        type: 'text',
        text: { preview_url: false, body },
      }),
    },
  );

  if (!response.ok) {
    const details = await response.text();
    throw new Error(`WhatsApp API ${response.status}: ${details}`);
  }
}

function extractMessages(payload) {
  const messages = [];

  for (const entry of payload?.entry || []) {
    for (const change of entry.changes || []) {
      const value = change.value;
      for (const message of value?.messages || []) {
        messages.push({
          message,
          phoneNumberId: value?.metadata?.phone_number_id,
        });
      }
    }
  }

  return messages;
}

async function handleWebhook(payload) {
  for (const { message, phoneNumberId } of extractMessages(payload)) {
    if (!message.id || processedMessageIds.has(message.id)) {
      continue;
    }
    processedMessageIds.add(message.id);

    // Evita que el set crezca indefinidamente en una demo de larga duración.
    if (processedMessageIds.size > 10_000) {
      const oldestId = processedMessageIds.values().next().value;
      processedMessageIds.delete(oldestId);
    }

    const userId = message.from;
    if (!userId) {
      continue;
    }

    const userText = textFromMessage(message);
    const reply = userText
      ? await createAssistantReply(userId, userText)
      : `Por ahora puedo atender mensajes de texto. ¿Qué necesitas o qué te gustaría hacer?`;

    try {
      await sendWhatsAppText(userId, reply, phoneNumberId || process.env.META_PHONE_NUMBER_ID);
    } catch (error) {
      console.error('Error al enviar mensaje por WhatsApp:', error.message);
    }
  }
}

app.get('/health', (_request, response) => {
  response.json({
    ok: true,
    service: 'whatsapp-asistente-ia',
    openaiConfigured: Boolean(openai),
    whatsappConfigured: Boolean(process.env.META_ACCESS_TOKEN && process.env.META_PHONE_NUMBER_ID),
  });
});

app.get(webhookPath, (request, response) => {
  const mode = request.query['hub.mode'];
  const token = request.query['hub.verify_token'];
  const challenge = request.query['hub.challenge'];

  if (mode === 'subscribe' && token === process.env.META_VERIFY_TOKEN && challenge) {
    return response.status(200).send(challenge);
  }

  return response.sendStatus(403);
});

app.post(webhookPath, (request, response) => {
  // Meta espera una confirmación rápida; el procesamiento continúa después.
  response.sendStatus(200);
  void handleWebhook(request.body);
});

app.listen(port, () => {
  console.log(`Asistente de WhatsApp escuchando en http://localhost:${port}`);
  console.log(`Webhook: ${webhookPath}`);
  if (!openai) console.warn('OPENAI_API_KEY no configurada; se usará el mensaje de respaldo.');
  if (!process.env.META_ACCESS_TOKEN || !process.env.META_PHONE_NUMBER_ID) {
    console.warn('Faltan credenciales de WhatsApp; los mensajes no se podrán enviar todavía.');
  }

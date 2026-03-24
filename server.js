const express = require("express");
const axios = require("axios");

const app = express();
app.use(express.json({ limit: "10mb" }));

const PORT = process.env.PORT || 3000;
const VERIFY_TOKEN = "matheo_os_123";

const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

app.get("/", (req, res) => {
  res.status(200).send("Matheo OS is running");
});

app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }

  return res.sendStatus(403);
});

async function sendWhatsAppMessage(to, body) {
  return axios.post(
    `https://graph.facebook.com/v22.0/${PHONE_NUMBER_ID}/messages`,
    {
      messaging_product: "whatsapp",
      to,
      type: "text",
      text: { body: String(body || "").slice(0, 1500) }
    },
    {
      headers: {
        Authorization: `Bearer ${WHATSAPP_TOKEN}`,
        "Content-Type": "application/json"
      },
      timeout: 30000
    }
  );
}

async function askOpenAIText(userMessage) {
  const response = await axios.post(
    "https://api.openai.com/v1/responses",
    {
      model: "gpt-5.4-mini",
      instructions:
        "Tu es Mathéo OS, l'assistant personnel de Mathéo. Réponds toujours en français, de façon claire, courte, utile et orientée action.",
      input: userMessage
    },
    {
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json"
      },
      timeout: 30000
    }
  );

  const data = response.data;

  const text =
    data.output_text ||
    data.output
      ?.flatMap(item => item.content || [])
      ?.find(content => content.type === "output_text")
      ?.text ||
    "Je n’ai pas réussi à répondre correctement.";

  return text.trim();
}

async function getWhatsAppMediaUrl(mediaId) {
  const response = await axios.get(
    `https://graph.facebook.com/v22.0/${mediaId}`,
    {
      headers: {
        Authorization: `Bearer ${WHATSAPP_TOKEN}`
      },
      timeout: 30000
    }
  );

  return {
    url: response.data.url,
    mime_type: response.data.mime_type
  };
}

async function downloadWhatsAppMedia(mediaUrl) {
  const response = await axios.get(mediaUrl, {
    responseType: "arraybuffer",
    headers: {
      Authorization: `Bearer ${WHATSAPP_TOKEN}`
    },
    timeout: 30000
  });

  return Buffer.from(response.data);
}

async function askOpenAIImage(imageBuffer, mimeType, userCaption = "") {
  const base64Image = imageBuffer.toString("base64");
  const dataUrl = `data:${mimeType};base64,${base64Image}`;

  const response = await axios.post(
    "https://api.openai.com/v1/responses",
    {
      model: "gpt-5.4-mini",
      input: [
        {
          role: "system",
          content: [
            {
              type: "input_text",
              text:
                "Tu es Mathéo OS, l'assistant personnel de Mathéo. Analyse l'image en français. Sois concret, utile, orienté action. Si c'est un screenshot, explique ce que tu vois et ce que Mathéo devrait faire."
            }
          ]
        },
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text: userCaption || "Analyse cette image et dis-moi ce que je dois comprendre ou faire."
            },
            {
              type: "input_image",
              image_url: dataUrl,
              detail: "high"
            }
          ]
        }
      ]
    },
    {
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json"
      },
      timeout: 60000
    }
  );

  const data = response.data;

  const text =
    data.output_text ||
    data.output
      ?.flatMap(item => item.content || [])
      ?.find(content => content.type === "output_text")
      ?.text ||
    "Je vois l’image, mais je n’ai pas réussi à produire une analyse exploitable.";

  return text.trim();
}

app.post("/webhook", async (req, res) => {
  try {
    const message = req.body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];

    if (!message) {
      return res.sendStatus(200);
    }

    const from = message.from;

    console.log("Type message reçu :", message.type);

    if (message.type === "text") {
      const text = message.text?.body?.trim();

      if (!text) {
        await sendWhatsAppMessage(from, "Envoie-moi un message texte.");
        return res.sendStatus(200);
      }

      console.log("Message texte reçu :", text);

      const aiReply = await askOpenAIText(text);
      await sendWhatsAppMessage(from, aiReply);

      return res.sendStatus(200);
    }

    if (message.type === "image") {
      const mediaId = message.image?.id;
      const caption = message.image?.caption || "";

      if (!mediaId) {
        await sendWhatsAppMessage(from, "Je n’ai pas réussi à récupérer l’image.");
        return res.sendStatus(200);
      }

      console.log("Image reçue, mediaId :", mediaId);

      const { url, mime_type } = await getWhatsAppMediaUrl(mediaId);
      const imageBuffer = await downloadWhatsAppMedia(url);
      const aiReply = await askOpenAIImage(imageBuffer, mime_type, caption);

      await sendWhatsAppMessage(from, aiReply);

      return res.sendStatus(200);
    }

    await sendWhatsAppMessage(
      from,
      "Pour l’instant, je gère surtout le texte et les images. Envoie-moi un texte ou un screenshot."
    );

    return res.sendStatus(200);
  } catch (error) {
    console.error("ERREUR WEBHOOK :");
    console.error(error.response?.data || error.message || error);
    return res.sendStatus(500);
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running on port ${PORT}`);
});

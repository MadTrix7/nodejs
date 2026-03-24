const express = require("express");
const axios = require("axios");

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const VERIFY_TOKEN = "matheo_os_123";

const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

app.get("/", (req, res) => {
  res.status(200).send("Matheo OS is running");
});

// Vérification webhook Meta
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }

  return res.sendStatus(403);
});

// 🔥 OPENAI
async function askOpenAI(userMessage) {
  const response = await axios.post(
    "https://api.openai.com/v1/responses",
    {
      model: "gpt-5.4-mini",
      instructions:
        "Tu es Mathéo OS, assistant personnel. Réponds en français, court, clair, utile, orienté action.",
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

  console.log("Réponse OpenAI brute :", JSON.stringify(data, null, 2));

  // ✅ PARSING ROBUSTE
  const text =
    data.output_text ||
    data.output
      ?.flatMap(item => item.content || [])
      ?.find(content => content.type === "output_text")
      ?.text ||
    "Je n’ai pas réussi à répondre correctement.";

  return text.trim();
}

// 🔥 ENVOI WHATSAPP
async function sendWhatsAppMessage(to, body) {
  return axios.post(
    `https://graph.facebook.com/v22.0/${PHONE_NUMBER_ID}/messages`,
    {
      messaging_product: "whatsapp",
      to,
      type: "text",
      text: {
        body: body.slice(0, 1500)
      }
    },
    {
      headers: {
        Authorization: `Bearer ${WHATSAPP_TOKEN}`,
        "Content-Type": "application/json"
      }
    }
  );
}

// 🔥 WEBHOOK PRINCIPAL
app.post("/webhook", async (req, res) => {
  try {
    const message = req.body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];

    if (!message) return res.sendStatus(200);

    const from = message.from;
    const text = message.text?.body?.trim();

    console.log("Message reçu :", text);
    console.log("OPENAI_API_KEY :", !!OPENAI_API_KEY);
    console.log("PHONE_NUMBER_ID :", !!PHONE_NUMBER_ID);
    console.log("WHATSAPP_TOKEN :", !!WHATSAPP_TOKEN);

    if (!text) {
      await sendWhatsAppMessage(from, "Envoie-moi un message texte.");
      return res.sendStatus(200);
    }

    // 🔥 IA
    const aiReply = await askOpenAI(text);

    // 🔥 ENVOI
    await sendWhatsAppMessage(from, aiReply);

    return res.sendStatus(200);
  } catch (error) {
    console.error("ERREUR WEBHOOK :");
    console.error(error.response?.data || error.message || error);

    return res.sendStatus(500);
  }
});

// 🔥 LANCEMENT
app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running on port ${PORT}`);
});

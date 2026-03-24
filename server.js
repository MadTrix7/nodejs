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

app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }

  return res.sendStatus(403);
});

async function askOpenAI(userMessage) {
  const prompt = `
Tu es Mathéo OS, l'assistant personnel de Mathéo.
Tu réponds toujours en français.
Tu es clair, court, concret, utile, orienté action.
Tu aides sur :
- organisation
- priorisation
- business
- rédaction rapide
- clarté mentale

Règles :
- pas de blabla
- pas de listes trop longues
- sois direct
- maximum 8 lignes
- si la demande est vague, propose l'action la plus utile maintenant

Message utilisateur : ${userMessage}
`;

  const response = await axios.post(
    "https://api.openai.com/v1/responses",
    {
      model: "gpt-5.4-mini",
      input: prompt
    },
    {
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json"
      },
      timeout: 30000
    }
  );

  console.log("Réponse OpenAI reçue");

  if (response.data.output_text && response.data.output_text.trim()) {
    return response.data.output_text.trim();
  }

  console.log("Réponse OpenAI brute :", JSON.stringify(response.data, null, 2));
  return "Je n’ai pas réussi à répondre correctement. Réessaie en une phrase simple.";
}

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
      },
      timeout: 30000
    }
  );
}

app.post("/webhook", async (req, res) => {
  try {
    const message = req.body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];

    if (!message) {
      return res.sendStatus(200);
    }

    const from = message.from;
    const text = message.text?.body?.trim();

    console.log("Message reçu :", text);
    console.log("OPENAI_API_KEY présente :", !!OPENAI_API_KEY);
    console.log("PHONE_NUMBER_ID présent :", !!PHONE_NUMBER_ID);
    console.log("WHATSAPP_TOKEN présent :", !!WHATSAPP_TOKEN);

    if (!text) {
      await sendWhatsAppMessage(from, "Envoie-moi un message texte.");
      return res.sendStatus(200);
    }

    const aiReply = await askOpenAI(text);
    await sendWhatsAppMessage(from, aiReply);

    return res.sendStatus(200);
  } catch (error) {
    console.error("Erreur webhook complète :");
    console.error(error.response?.data || error.message || error);
    return res.sendStatus(500);
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running on port ${PORT}`);
});

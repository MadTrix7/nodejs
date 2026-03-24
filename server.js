const express = require("express");
const axios = require("axios");
const { Client } = require("@notionhq/client");

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const VERIFY_TOKEN = "matheo_os_123";

const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

const NOTION_API_KEY = process.env.NOTION_API_KEY;
const NOTION_TASKS_DATABASE_ID = process.env.NOTION_TASKS_DATABASE_ID;
const NOTION_PROFILE_PAGE_ID = process.env.NOTION_PROFILE_PAGE_ID;

const notion =
  NOTION_API_KEY
    ? new Client({ auth: NOTION_API_KEY })
    : null;

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

function normalizeText(text) {
  return (text || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .trim();
}

function extractPlainTextFromRichText(richTextArray) {
  if (!Array.isArray(richTextArray)) return "";
  return richTextArray.map((item) => item.plain_text || "").join("");
}

function formatTaskTitle(page) {
  const title =
    page.properties?.Name?.title ||
    page.properties?.Titre?.title ||
    [];
  return extractPlainTextFromRichText(title) || "Sans titre";
}

function formatTaskStatus(page) {
  const status =
    page.properties?.Status?.select?.name ||
    page.properties?.Statut?.select?.name ||
    page.properties?.Status?.status?.name ||
    page.properties?.Statut?.status?.name ||
    "Sans statut";
  return status;
}

function formatTaskDate(page) {
  const date =
    page.properties?.Date?.date?.start ||
    page.properties?.DueDate?.date?.start ||
    page.properties?.Echeance?.date?.start ||
    null;
  return date;
}

async function sendWhatsAppMessage(to, body) {
  return axios.post(
    `https://graph.facebook.com/v22.0/${PHONE_NUMBER_ID}/messages`,
    {
      messaging_product: "whatsapp",
      to,
      type: "text",
      text: {
        body: String(body || "").slice(0, 1500)
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

async function askOpenAI(userMessage, context = "") {
  const response = await axios.post(
    "https://api.openai.com/v1/responses",
    {
      model: "gpt-5.4-mini",
      instructions:
        "Tu es Mathéo OS, l'assistant personnel de Mathéo. " +
        "Tu réponds toujours en français. " +
        "Sois court, clair, utile, orienté action. " +
        "Quand tu as du contexte Notion, appuie-toi dessus. " +
        "Évite le blabla. " +
        "Maximum 10 lignes.",
      input:
        `CONTEXTE NOTION :\n${context || "Aucun contexte disponible."}\n\n` +
        `MESSAGE UTILISATEUR : ${userMessage}`
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
      ?.flatMap((item) => item.content || [])
      ?.find((content) => content.type === "output_text")
      ?.text ||
    "Je n’ai pas réussi à répondre correctement.";

  return text.trim();
}

async function addTaskToNotion(taskName) {
  if (!notion || !NOTION_TASKS_DATABASE_ID) {
    throw new Error("Notion Tasks non configuré.");
  }

  await notion.pages.create({
    parent: {
      database_id: NOTION_TASKS_DATABASE_ID
    },
    properties: {
      Name: {
        title: [
          {
            text: {
              content: taskName
            }
          }
        ]
      }
    }
  });
}

async function listTasksFromNotion(limit = 8) {
  if (!notion || !NOTION_TASKS_DATABASE_ID) {
    return [];
  }

  const response = await notion.databases.query({
    database_id: NOTION_TASKS_DATABASE_ID,
    page_size: limit
  });

  return response.results || [];
}

async function getTasksSummary(limit = 8) {
  const tasks = await listTasksFromNotion(limit);

  if (!tasks.length) {
    return "Aucune tâche trouvée.";
  }

  return tasks
    .map((page, index) => {
      const title = formatTaskTitle(page);
      const status = formatTaskStatus(page);
      const date = formatTaskDate(page);

      return `${index + 1}. ${title} — ${status}${date ? ` — ${date}` : ""}`;
    })
    .join("\n");
}

async function getProfilePageText(pageId) {
  if (!notion || !pageId) return "";

  try {
    const blocks = [];
    let cursor = undefined;
    let hasMore = true;

    while (hasMore) {
      const response = await notion.blocks.children.list({
        block_id: pageId,
        start_cursor: cursor,
        page_size: 100
      });

      blocks.push(...response.results);
      hasMore = response.has_more;
      cursor = response.next_cursor || undefined;
    }

    const lines = [];

    for (const block of blocks) {
      const type = block.type;
      const value = block[type];

      if (!value) continue;

      if (Array.isArray(value.rich_text) && value.rich_text.length > 0) {
        const text = extractPlainTextFromRichText(value.rich_text).trim();
        if (text) lines.push(text);
      }
    }

    return lines.join("\n");
  } catch (error) {
    console.error("Erreur lecture page profile Notion :");
    console.error(error.body || error.message || error);
    return "";
  }
}

async function buildContext() {
  const parts = [];

  const profileText = await getProfilePageText(NOTION_PROFILE_PAGE_ID);
  if (profileText) {
    parts.push(`PROFIL MATHÉO :\n${profileText}`);
  }

  const tasksSummary = await getTasksSummary(8);
  if (tasksSummary) {
    parts.push(`TÂCHES ACTUELLES :\n${tasksSummary}`);
  }

  return parts.join("\n\n");
}

function parseAddTaskCommand(text) {
  const normalized = normalizeText(text);

  const prefixes = [
    "ajoute une tache",
    "ajoute tache",
    "cree une tache",
    "cree tache",
    "crée une tâche",
    "crée tâche"
  ];

  const matchedPrefix = prefixes.find((prefix) =>
    normalized.startsWith(prefix)
  );

  if (!matchedPrefix) return null;

  const original = text.trim();
  const splitIndex = original.indexOf(":");

  if (splitIndex !== -1) {
    return original.slice(splitIndex + 1).trim();
  }

  return original
    .replace(/^ajoute une tâche/i, "")
    .replace(/^ajoute une tache/i, "")
    .replace(/^ajoute tâche/i, "")
    .replace(/^ajoute tache/i, "")
    .replace(/^crée une tâche/i, "")
    .replace(/^cree une tache/i, "")
    .replace(/^crée tâche/i, "")
    .replace(/^cree tache/i, "")
    .trim();
}

function isListTasksCommand(text) {
  const normalized = normalizeText(text);

  return [
    "mes taches",
    "mes tâches",
    "liste mes taches",
    "liste mes tâches",
    "montre mes taches",
    "montre mes tâches",
    "quelles sont mes taches",
    "quelles sont mes tâches"
  ].some((command) => normalized === normalizeText(command));
}

app.post("/webhook", async (req, res) => {
  try {
    const message = req.body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];

    if (!message) {
      return res.sendStatus(200);
    }

    const from = message.from;
    const text = message.text?.body?.trim();

    if (!text) {
      await sendWhatsAppMessage(from, "Envoie-moi un message texte.");
      return res.sendStatus(200);
    }

    console.log("Message reçu :", text);

    const taskToAdd = parseAddTaskCommand(text);

    if (taskToAdd) {
      if (!taskToAdd) {
        await sendWhatsAppMessage(from, "Dis-moi le nom de la tâche à ajouter.");
        return res.sendStatus(200);
      }

      await addTaskToNotion(taskToAdd);
      await sendWhatsAppMessage(from, `Tâche ajoutée dans Notion ✅\n${taskToAdd}`);
      return res.sendStatus(200);
    }

    if (isListTasksCommand(text)) {
      const tasksSummary = await getTasksSummary(10);
      await sendWhatsAppMessage(from, tasksSummary);
      return res.sendStatus(200);
    }

    const context = await buildContext();
    const aiReply = await askOpenAI(text, context);

    await sendWhatsAppMessage(from, aiReply);
    return res.sendStatus(200);
  } catch (error) {
    console.error("ERREUR WEBHOOK :");
    console.error(error.response?.data || error.body || error.message || error);
    return res.sendStatus(500);
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running on port ${PORT}`);
});

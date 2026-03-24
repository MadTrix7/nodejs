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
const NOTION_TASKS_DATABASE_ID = process.env.NOTION_TASKS_DATABASE_ID || "";
const NOTION_PROFILE_PAGE_ID = process.env.NOTION_PROFILE_PAGE_ID || "";

const notion = NOTION_API_KEY
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

function getPlainTextFromRichText(richTextArray) {
  if (!Array.isArray(richTextArray)) return "";
  return richTextArray.map((item) => item.plain_text || "").join("");
}

function getPageTitle(page) {
  if (!page?.properties) return "Sans titre";

  for (const key of Object.keys(page.properties)) {
    const prop = page.properties[key];
    if (prop?.type === "title") {
      return getPlainTextFromRichText(prop.title) || "Sans titre";
    }
  }

  return "Sans titre";
}

function getTaskStatus(page) {
  if (!page?.properties) return "Sans statut";

  for (const key of Object.keys(page.properties)) {
    const prop = page.properties[key];
    if (prop?.type === "status") return prop.status?.name || "Sans statut";
    if (prop?.type === "select" && normalizeText(key).includes("status")) {
      return prop.select?.name || "Sans statut";
    }
    if (prop?.type === "select" && normalizeText(key).includes("statut")) {
      return prop.select?.name || "Sans statut";
    }
  }

  return "Sans statut";
}

function getTaskDate(page) {
  if (!page?.properties) return null;

  for (const key of Object.keys(page.properties)) {
    const prop = page.properties[key];
    if (prop?.type === "date") {
      return prop.date?.start || null;
    }
  }

  return null;
}

async function sendWhatsAppMessage(to, body) {
  return axios.post(
    `https://graph.facebook.com/v22.0/${PHONE_NUMBER_ID}/messages`,
    {
      messaging_product: "whatsapp",
      to,
      type: "text",
      text: {
        body: String(body || "").slice(0, 1500),
      },
    },
    {
      headers: {
        Authorization: `Bearer ${WHATSAPP_TOKEN}`,
        "Content-Type": "application/json",
      },
      timeout: 30000,
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
        "Tu es clair, direct, utile, orienté action. " +
        "Tu peux analyser des notes, pages Notion, réflexions, projets, tâches et contextes business. " +
        "Tu ne fais pas de blabla inutile. " +
        "Quand tu analyses une page, tu identifies : 1) ce que ça dit vraiment, 2) ce qui manque, 3) quoi faire maintenant. " +
        "Maximum 10 lignes sauf si une structure plus longue est vraiment utile.",
      input:
        `CONTEXTE NOTION :\n${context || "Aucun contexte disponible."}\n\n` +
        `MESSAGE UTILISATEUR : ${userMessage}`,
    },
    {
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      timeout: 30000,
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
      database_id: NOTION_TASKS_DATABASE_ID,
    },
    properties: {
      Name: {
        title: [
          {
            text: {
              content: taskName,
            },
          },
        ],
      },
    },
  });
}

async function listTasksFromNotion(limit = 10) {
  if (!notion || !NOTION_TASKS_DATABASE_ID) return [];

  const response = await notion.databases.query({
    database_id: NOTION_TASKS_DATABASE_ID,
    page_size: limit,
  });

  return response.results || [];
}

async function getTasksSummary(limit = 10) {
  const tasks = await listTasksFromNotion(limit);

  if (!tasks.length) {
    return "Aucune tâche trouvée.";
  }

  return tasks
    .map((task, index) => {
      const title = getPageTitle(task);
      const status = getTaskStatus(task);
      const date = getTaskDate(task);

      return `${index + 1}. ${title} — ${status}${date ? ` — ${date}` : ""}`;
    })
    .join("\n");
}

async function getBlockChildren(blockId) {
  let results = [];
  let hasMore = true;
  let cursor = undefined;

  while (hasMore) {
    const response = await notion.blocks.children.list({
      block_id: blockId,
      start_cursor: cursor,
      page_size: 100,
    });

    results = results.concat(response.results);
    hasMore = response.has_more;
    cursor = response.next_cursor || undefined;
  }

  return results;
}

function extractBlockText(block) {
  const type = block.type;
  const value = block[type];

  if (!value) return "";

  if (Array.isArray(value.rich_text) && value.rich_text.length > 0) {
    return getPlainTextFromRichText(value.rich_text).trim();
  }

  return "";
}

async function getPageContent(pageId) {
  if (!notion) return "";

  try {
    const blocks = await getBlockChildren(pageId);
    const lines = [];

    for (const block of blocks) {
      const text = extractBlockText(block);
      if (text) lines.push(text);
    }

    return lines.join("\n");
  } catch (error) {
    console.error("Erreur lecture contenu page :", error.body || error.message || error);
    return "";
  }
}

async function searchPageByTitle(query) {
  if (!notion) return null;

  const response = await notion.search({
    query,
    filter: {
      value: "page",
      property: "object",
    },
    page_size: 10,
  });

  const results = response.results || [];
  if (!results.length) return null;

  const normalizedQuery = normalizeText(query);

  const scored = results.map((page) => {
    const title = getPageTitle(page);
    const normalizedTitle = normalizeText(title);

    let score = 0;
    if (normalizedTitle === normalizedQuery) score += 100;
    if (normalizedTitle.includes(normalizedQuery)) score += 50;
    if (normalizedQuery.includes(normalizedTitle)) score += 25;

    return { page, title, score };
  });

  scored.sort((a, b) => b.score - a.score);
  return scored[0].page || null;
}

async function getProfileText() {
  if (!NOTION_PROFILE_PAGE_ID) return "";
  return getPageContent(NOTION_PROFILE_PAGE_ID);
}

async function buildGeneralContext() {
  const parts = [];

  const profileText = await getProfileText();
  if (profileText) {
    parts.push(`PROFIL MATHÉO :\n${profileText}`);
  }

  if (NOTION_TASKS_DATABASE_ID) {
    const tasksSummary = await getTasksSummary(8);
    if (tasksSummary) {
      parts.push(`TÂCHES ACTUELLES :\n${tasksSummary}`);
    }
  }

  return parts.join("\n\n");
}

function parseAddTaskCommand(text) {
  const normalized = normalizeText(text);

  const prefixes = [
    "ajoute une tache",
    "ajoute une tâche",
    "ajoute tache",
    "ajoute tâche",
    "cree une tache",
    "crée une tâche",
    "cree tache",
    "crée tâche",
  ];

  const matched = prefixes.find((prefix) => normalized.startsWith(normalizeText(prefix)));
  if (!matched) return null;

  const colonIndex = text.indexOf(":");
  if (colonIndex !== -1) {
    return text.slice(colonIndex + 1).trim();
  }

  return text
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

  const commands = [
    "mes taches",
    "mes tâches",
    "liste mes taches",
    "liste mes tâches",
    "montre mes taches",
    "montre mes tâches",
    "quelles sont mes taches",
    "quelles sont mes tâches",
  ];

  return commands.some((cmd) => normalizeText(cmd) === normalized);
}

function parsePageAnalysisCommand(text) {
  const patterns = [
    /^analyse la page (.+)$/i,
    /^va voir la page (.+)$/i,
    /^regarde la page (.+)$/i,
    /^lis la page (.+)$/i,
    /^analyse (.+)$/i,
    /^regarde (.+) et dis-moi quoi faire$/i,
    /^tu vois la page (.+)$/i,
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match && match[1]) {
      return match[1].trim();
    }
  }

  return null;
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
      await addTaskToNotion(taskToAdd);
      await sendWhatsAppMessage(from, `Tâche ajoutée dans Notion ✅\n${taskToAdd}`);
      return res.sendStatus(200);
    }

    if (isListTasksCommand(text)) {
      const tasksSummary = await getTasksSummary(10);
      await sendWhatsAppMessage(from, tasksSummary);
      return res.sendStatus(200);
    }

    const requestedPageTitle = parsePageAnalysisCommand(text);
    if (requestedPageTitle) {
      const page = await searchPageByTitle(requestedPageTitle);

      if (!page) {
        await sendWhatsAppMessage(
          from,
          `Je n’ai pas trouvé de page Notion proche de : ${requestedPageTitle}`
        );
        return res.sendStatus(200);
      }

      const pageTitle = getPageTitle(page);
      const pageContent = await getPageContent(page.id);

      const context =
        `PAGE NOTION TROUVÉE : ${pageTitle}\n\n` +
        `CONTENU DE LA PAGE :\n${pageContent || "Aucun contenu lisible."}\n\n` +
        `PROFIL MATHÉO :\n${await getProfileText()}`;

      const aiReply = await askOpenAI(
        `Analyse cette page et dis-moi quoi faire maintenant : ${pageTitle}`,
        context
      );

      await sendWhatsAppMessage(from, aiReply);
      return res.sendStatus(200);
    }

    const generalContext = await buildGeneralContext();
    const aiReply = await askOpenAI(text, generalContext);

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

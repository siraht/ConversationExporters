#!/usr/bin/env node

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright";

function option(name) {
  const index = process.argv.indexOf(name);
  if (index < 0 || !process.argv[index + 1]) throw new Error(`Missing ${name}.`);
  return process.argv[index + 1];
}

function optionalOption(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function normalize(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim().toLocaleLowerCase("en-US");
}

function classify(conversation, serialized, assets) {
  const categories = new Set();
  const messages = Array.isArray(conversation.messages) ? conversation.messages : [];
  const nodes = Array.isArray(conversation.nodes) ? conversation.nodes : [];
  const memberships = Array.isArray(conversation.memberships) ? conversation.memberships : [];
  const parts = messages.flatMap((message) => Array.isArray(message.parts) ? message.parts : []);
  const kinds = new Set(parts.map((part) => String(part?.kind ?? "").toLowerCase()));
  const assetKinds = assets.map((asset) => String(asset?.kind ?? "").toLowerCase()).join(" ");
  const createdAt = typeof conversation.createTime === "number" ? conversation.createTime : null;

  if (messages.length <= 4) categories.add("short");
  if (messages.length <= 6 && /\b(test|testing|synthetic|hello|ping)\b/.test(serialized)) categories.add("calibration");
  if (messages.length >= 50) categories.add("long");
  if (nodes.some((node) => Array.isArray(node.childIds) && node.childIds.length > 1)) categories.add("branched");
  if (createdAt !== null && createdAt < Date.UTC(2024, 0, 1) / 1000) categories.add("old");
  if (createdAt !== null && createdAt >= Date.UTC(2026, 0, 1) / 1000) categories.add("new");
  const scopes = new Set(memberships.map((membership) => String(membership?.scope ?? "")));
  for (const scope of ["archived", "project", "shared"]) {
    if (scopes.has(scope)) categories.add(scope);
  }
  if (["citation", "browsing", "web_search", "webpage"].some((kind) => kinds.has(kind))) categories.add("cited_or_browsed");
  if (["code", "execution_output", "tool", "tool_call"].some((kind) => kinds.has(kind))) categories.add("tool_or_code");
  if (serialized.includes("canvas") || serialized.includes("canmore")) categories.add("canvas");
  if ([...kinds].some((kind) => kind.includes("research"))) categories.add("deep_research");
  if (["upload", "file", "document"].some((kind) => assetKinds.includes(kind))) categories.add("uploaded_file");
  if (assets.length > 0 && ["dalle", "image_gen", "generated_image"].some((kind) => serialized.includes(kind))) categories.add("generated_image");
  return categories;
}

function anchors(conversation) {
  const values = [];
  for (const message of conversation.messages ?? []) {
    if (message.selected === false) continue;
    for (const part of message.parts ?? []) {
      if (typeof part?.text !== "string") continue;
      const value = normalize(part.text);
      if (value.length >= 30) values.push(value.slice(0, 80));
    }
  }
  return values;
}

const archiveRoot = option("--archive-root");
const cdp = option("--cdp");
const categoryOrder = [
  "calibration", "short", "long", "old", "new", "branched", "archived", "project", "shared",
  "cited_or_browsed", "tool_or_code", "uploaded_file", "generated_image", "canvas", "deep_research",
];
const selectedCategories = optionalOption("--categories")?.split(",").filter(Boolean) ?? categoryOrder;
const candidates = new Map(categoryOrder.map((category) => [category, []]));
const browserConnection = await chromium.connectOverCDP(`http://127.0.0.1:${cdp}`);
const context = browserConnection.contexts()[0];
if (!context) throw new Error("The CDP browser has no active context.");
const page = context.pages().find((candidate) => candidate.url().startsWith("https://chatgpt.com/")) ?? await context.newPage();

for (const name of readdirSync(join(archiveRoot, "conversations"))) {
  const directory = join(archiveRoot, "conversations", name);
  const conversationPath = join(directory, "conversation.json");
  if (!existsSync(conversationPath)) continue;
  const serialized = readFileSync(conversationPath, "utf8");
  const conversation = JSON.parse(serialized);
  const assetPath = join(directory, "assets.json");
  const assetDocument = existsSync(assetPath) ? JSON.parse(readFileSync(assetPath, "utf8")) : { assets: [] };
  const projectMembership = (conversation.memberships ?? []).find((membership) => membership?.scope === "project");
  const projectId = projectMembership?.projectId ? String(projectMembership.projectId) : null;
  const projectSlug = projectId ? (projectId.startsWith("g-p-") ? projectId : `g-p-${projectId}`) : null;
  const record = {
    id: conversation.conversationId,
    title: conversation.title,
    anchors: anchors(conversation),
    project: projectSlug !== null,
    route: projectSlug
      ? `https://chatgpt.com/g/${projectSlug}/c/${conversation.conversationId}`
      : `https://chatgpt.com/c/${conversation.conversationId}`,
  };
  if (!record.id || record.anchors.length === 0) continue;
  for (const category of classify(conversation, serialized.toLowerCase(), assetDocument.assets ?? [])) {
    candidates.get(category)?.push(record);
  }
}

const results = [];
for (const category of selectedCategories) {
  const categoryCandidates = candidates.get(category) ?? [];
  let sampled = false;
  let attempts = 0;
  for (const candidate of categoryCandidates.slice(0, 3)) {
    attempts += 1;
    try {
      await page.goto(candidate.route, {
        waitUntil: "domcontentloaded",
        timeout: 15_000,
      });
      await page.waitForFunction(
        () => document.body.innerText.length > 500 && document.title !== "ChatGPT",
        undefined,
        { timeout: 15_000 },
      );
      const url = page.url();
      const title = await page.title();
      const body = normalize(await page.evaluate(() => document.body.innerText.slice(0, 50_000)));
      const titleMatches = normalize(candidate.title) === normalize(title);
      const anchorMatches = candidate.anchors.filter((anchor) => body.includes(anchor)).length;
      const contentMatches = candidate.project ? anchorMatches > 0 : titleMatches && anchorMatches > 0;
      if (url.endsWith(`/c/${candidate.id}`) && contentMatches) {
        sampled = true;
        break;
      }
    } catch {
      // A stale or transiently unavailable UI route is not acceptance evidence; try the next candidate.
    }
  }
  const result = {
    category,
    available: categoryCandidates.length,
    attempts,
    sampled,
  };
  results.push(result);
  console.log(JSON.stringify(result));
}

console.log(JSON.stringify({
  schema: "chatgpt-exporter-private-ui-sample/1",
  categories: results,
  availableCategories: results.filter((result) => result.available > 0).length,
  sampledCategories: results.filter((result) => result.sampled).length,
  unavailableCategories: results.filter((result) => result.available === 0).map((result) => result.category),
  failedAvailableCategories: results.filter((result) => result.available > 0 && !result.sampled).map((result) => result.category),
}, null, 2));

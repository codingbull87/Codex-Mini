#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const [sessionsDir, sessionIndexFile, outputFile, maxFilesRaw] = process.argv.slice(2);
const maxFiles = Math.max(80, Math.min(2000, Number(maxFilesRaw) || 500));
const CODEX_SESSION_TAIL_BYTES = 5 * 1024 * 1024;
const CODEX_TITLE_SCAN_BYTES = 12 * 1024 * 1024;
const MAX_LINE_BYTES = 2 * 1024 * 1024;

function walkFiles(dir, out = []) {
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkFiles(full, out);
    else if (entry.isFile() && full.endsWith('.jsonl')) out.push(full);
  }
  return out;
}

function threadIdFromFile(file) {
  return (path.basename(file || '').match(/([a-f0-9]{8}-[a-f0-9-]{27,})\.jsonl$/i) || [])[1] || '';
}

function readIndexNames(file) {
  const byId = new Map();
  try {
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const item = JSON.parse(line);
        if (item && item.id) byId.set(item.id, { name: item.thread_name || '', updatedAt: item.updated_at || '' });
      } catch {}
    }
  } catch {}
  return byId;
}

function summarizeThreadTitle(value = '', max = 80) {
  const text = String(value || '')
    .replace(/\s+/g, ' ')
    .replace(/^# Files mentioned by the user:\s*/i, '')
    .trim();
  return text.length > max ? text.slice(0, max) : text;
}

function extractMessageText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map(item => item && (item.text || item.message || '')).filter(Boolean).join('\n');
}

function parseLine(line) {
  if (!line || line.length > MAX_LINE_BYTES) return null;
  try { return JSON.parse(line); } catch { return null; }
}

function scanLines(file, start, end, onItem) {
  const fd = fs.openSync(file, 'r');
  const chunkSize = 64 * 1024;
  const buffer = Buffer.alloc(chunkSize);
  let offset = start;
  let carry = '';
  let skippingLongLine = false;
  try {
    if (offset > 0) {
      const bytes = fs.readSync(fd, buffer, 0, Math.min(chunkSize, end - offset), offset);
      const text = buffer.toString('utf8', 0, bytes);
      const newline = text.indexOf('\n');
      if (newline >= 0) carry = text.slice(newline + 1);
      else skippingLongLine = true;
      offset += bytes;
    }
    while (offset < end) {
      const bytes = fs.readSync(fd, buffer, 0, Math.min(chunkSize, end - offset), offset);
      if (!bytes) break;
      offset += bytes;
      let text = buffer.toString('utf8', 0, bytes);
      if (skippingLongLine) {
        const newline = text.indexOf('\n');
        if (newline < 0) continue;
        text = text.slice(newline + 1);
        skippingLongLine = false;
      }
      carry += text;
      if (carry.length > MAX_LINE_BYTES) {
        const newline = carry.indexOf('\n');
        if (newline < 0) {
          carry = '';
          skippingLongLine = true;
          continue;
        }
      }
      let newlineIndex;
      while ((newlineIndex = carry.indexOf('\n')) >= 0) {
        const line = carry.slice(0, newlineIndex);
        carry = carry.slice(newlineIndex + 1);
        const item = parseLine(line);
        if (item && onItem(item) === false) return;
      }
    }
    if (carry.trim()) {
      const item = parseLine(carry);
      if (item) onItem(item);
    }
  } finally {
    try { fs.closeSync(fd); } catch {}
  }
}

function runtimeStatusFromItems(items) {
  let status = 'idle';
  let active = false;
  let startedAt = '';
  let completedAt = '';
  let updatedAt = '';
  let turnId = '';
  for (const item of items) {
    const payload = item.payload || {};
    if (item.type === 'event_msg' && payload.type === 'task_started') {
      status = 'running';
      active = true;
      startedAt = item.timestamp || startedAt;
      completedAt = '';
      updatedAt = item.timestamp || updatedAt;
      turnId = payload.turn_id || turnId;
    } else if (item.type === 'event_msg' && payload.type === 'task_complete') {
      status = 'idle';
      active = false;
      completedAt = item.timestamp || completedAt;
      updatedAt = item.timestamp || updatedAt;
      turnId = payload.turn_id || turnId;
    } else if (item.timestamp) {
      updatedAt = item.timestamp;
    }
  }
  return { runtimeStatus: status, runtimeActive: active, runtimeStartedAt: startedAt, runtimeCompletedAt: completedAt, runtimeUpdatedAt: updatedAt, runtimeTurnId: turnId };
}

function indexFile(file, indexed = {}) {
  const id = threadIdFromFile(file);
  if (!id) return null;
  const stat = fs.statSync(file);
  const row = {
    id,
    sessionFile: path.basename(file),
    mtimeMs: stat.mtimeMs,
    updatedAt: indexed.updatedAt || new Date(stat.mtimeMs).toISOString(),
    name: indexed.name || '',
    nameSource: indexed.name ? 'index' : '',
    cwd: '',
    source: '',
    threadSource: '',
    firstUserMessageAt: '',
    latestUserMessageAt: '',
    latestSnippet: '',
    latestSnippetAt: '',
    isSubagent: false,
  };

  const headEnd = Math.min(stat.size, CODEX_TITLE_SCAN_BYTES);
  scanLines(file, 0, headEnd, item => {
    const payload = item.payload || {};
    if (item.type === 'session_meta') {
      row.cwd = payload.cwd || row.cwd;
      row.source = payload.source || row.source;
      row.threadSource = payload.thread_source || row.threadSource;
      row.isSubagent = Boolean(payload.parent_agent_id || payload.parent_run_id || payload.agent_name);
      if (payload.timestamp && !row.updatedAt) row.updatedAt = payload.timestamp;
    }
    if (item.type === 'event_msg' && payload.type === 'user_message') {
      const title = summarizeThreadTitle(payload.message || '');
      if (title && !row.name) {
        row.name = title;
        row.nameSource = 'first_user_message';
      }
      if (item.timestamp && !row.firstUserMessageAt) row.firstUserMessageAt = item.timestamp;
      if (row.cwd && row.name && row.firstUserMessageAt) return false;
    }
    return true;
  });

  const tailStart = Math.max(0, stat.size - CODEX_SESSION_TAIL_BYTES);
  const tailItems = [];
  scanLines(file, tailStart, stat.size, item => {
    tailItems.push(item);
    const payload = item.payload || {};
    if (item.type === 'event_msg' && payload.type === 'user_message') {
      row.latestUserMessageAt = item.timestamp || row.latestUserMessageAt;
      const text = summarizeThreadTitle(payload.message || '', 160);
      if (text) {
        row.latestSnippet = text;
        row.latestSnippetAt = item.timestamp || row.latestSnippetAt;
      }
    } else if (item.type === 'response_item' && payload.type === 'message' && payload.role === 'assistant') {
      const text = summarizeThreadTitle(extractMessageText(payload.content), 160);
      if (text) {
        row.latestSnippet = text;
        row.latestSnippetAt = item.timestamp || row.latestSnippetAt;
      }
    }
    return true;
  });

  Object.assign(row, runtimeStatusFromItems(tailItems));
  row.name = row.name || `Codex ${id.slice(0, 8)}`;
  row.firstUserMessageAt = row.firstUserMessageAt || row.updatedAt;
  row.latestUserMessageAt = row.latestUserMessageAt || row.firstUserMessageAt;
  row.latestSnippet = row.latestSnippet || row.name;
  row.latestSnippetAt = row.latestSnippetAt || row.updatedAt;
  row.effectiveUpdatedMs = Math.max(Date.parse(row.updatedAt || '') || 0, Date.parse(row.latestUserMessageAt || '') || 0, stat.mtimeMs || 0);
  row.effectiveUpdatedAt = new Date(row.effectiveUpdatedMs).toISOString();
  return row;
}

function main() {
  const names = readIndexNames(sessionIndexFile);
  const files = walkFiles(sessionsDir)
    .map(file => {
      try { return { file, stat: fs.statSync(file) }; } catch { return null; }
    })
    .filter(Boolean)
    .sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs)
    .slice(0, maxFiles);
  const threads = [];
  for (const row of files) {
    const id = threadIdFromFile(row.file);
    try {
      const indexed = names.get(id) || {};
      const item = indexFile(row.file, indexed);
      if (item) threads.push(item);
    } catch {}
  }
  const payload = {
    generatedAt: new Date().toISOString(),
    host: os.hostname(),
    maxFiles,
    threads,
  };
  fs.mkdirSync(path.dirname(outputFile), { recursive: true });
  const tmp = `${outputFile}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(payload)}\n`, 'utf8');
  fs.renameSync(tmp, outputFile);
}

main();

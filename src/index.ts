#!/usr/bin/env node

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
} from '@modelcontextprotocol/sdk/types.js';
import { chromium, type Page, type Locator } from 'playwright';
import { z } from 'zod';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import 'dotenv/config';

// 名称一貫性
const SERVER_NAME = process.env.MCP_NAME ?? 'note-post-mcp';
const SERVER_VERSION = '1.0.0';

// 環境変数デフォルト
const DEFAULT_STATE_PATH = process.env.NOTE_POST_MCP_STATE_PATH ?? 
  path.join(os.homedir(), '.note-state.json');
const DEFAULT_TIMEOUT = parseInt(process.env.NOTE_POST_MCP_TIMEOUT ?? '180000', 10);

// ログ用ユーティリティ
function log(message: string, data?: any) {
  const timestamp = new Date().toISOString();
  console.error(`[${timestamp}] [${SERVER_NAME}] ${message}`, data ?? '');
}

// 現在時刻のフォーマット
function nowStr(): string {
  const d = new Date();
  const z = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())}_${z(d.getHours())}-${z(d.getMinutes())}-${z(d.getSeconds())}`;
}

// 画像情報の型定義
interface ImageInfo {
  alt: string;
  localPath: string;
  absolutePath: string;
  placeholder: string;
}

// 本文画像挿入のコンテキスト/結果型 (2026-04-25 多戦略対応のため追加)
interface InsertImageContext {
  page: Page;
  bodyBox: Locator;
  imagePath: string;
  imageAlt: string;         // alt 文字列 → figcaption に挿入
  imageIndex: number;       // 1-based, ログ用
  totalImages: number;
  screenshotDir: string;
  isMac: boolean;
  pasteKey: string;
}

interface InsertImageResult {
  success: boolean;
  strategy: 'inputFiles' | 'drop' | 'clipboard' | 'failed';
  imgCountBefore: number;
  imgCountAfter: number;
  errorMessage?: string;
}

// Markdownから画像パスを抽出する関数
function extractImages(markdown: string, baseDir: string): ImageInfo[] {
  const imageRegex = /!\[([^\]]*)\]\(([^)]+)\)/g;
  const images: ImageInfo[] = [];
  let match;

  while ((match = imageRegex.exec(markdown)) !== null) {
    const alt = match[1] || 'image';
    const imagePath = match[2];
    
    // URLではなくローカルパスの場合のみ処理
    if (!imagePath.startsWith('http://') && !imagePath.startsWith('https://')) {
      const absolutePath = path.resolve(baseDir, imagePath);
      if (fs.existsSync(absolutePath)) {
        images.push({
          alt,
          localPath: imagePath,
          absolutePath,
          placeholder: match[0], // 元のマークダウン記法全体
        });
      } else {
        log(`Warning: Image file not found: ${absolutePath}`);
      }
    }
  }

  return images;
}

// ─────────────────────────────────────────────────────────
// 本文画像挿入用ヘルパー (2026-04-25 多戦略対応)
// ─────────────────────────────────────────────────────────

// 本文 contenteditable 内の <img> 要素数を取得
async function countImages(bodyBox: Locator): Promise<number> {
  try {
    return await bodyBox.evaluate((el) => el.querySelectorAll('img').length);
  } catch {
    return 0;
  }
}

// デバッグ用 screenshot
async function debugSnapshot(
  page: Page,
  screenshotDir: string,
  label: string
): Promise<void> {
  try {
    const filePath = path.join(screenshotDir, `debug-${label}-${nowStr()}.png`);
    await page.screenshot({ path: filePath, fullPage: false });
    log(`debug screenshot: ${filePath}`);
  } catch (e: any) {
    log('debug screenshot failed', e?.message);
  }
}

// note エディタの hidden file input を探索 (image accept 優先)
async function findHiddenImageInput(page: Page): Promise<Locator | null> {
  const candidates = [
    'input[type="file"][accept*="image"]',
    'input[type="file"][name*="image"]',
    // フォールバック: 画像専用 input が見つからない場合
    // 注意: サムネ用 input (accept "image/*") と同居している場合あり、
    // accept パターンで絞り込んだ後の最終手段
  ];
  for (const sel of candidates) {
    const loc = page.locator(sel);
    const count = await loc.count();
    if (count > 0) return loc.first();
  }
  return null;
}

// 画像挿入後 bodyBox 内の <img> 数が増えるまで待機
async function waitForImageAdded(
  bodyBox: Locator,
  before: number,
  timeoutMs = 8000
): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const now = await countImages(bodyBox);
    if (now > before) return true;
    await new Promise(r => setTimeout(r, 200));
  }
  return false;
}

// Markdownファイルをパースする関数
function parseMarkdown(content: string): {
  title: string;
  body: string;
  tags: string[];
} {
  const lines = content.split('\n');
  let title = '';
  let body = '';
  const tags: string[] = [];
  let inFrontMatter = false;
  let frontMatterEnded = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Front matter の処理（YAML形式）
    if (line.trim() === '---') {
      if (!frontMatterEnded) {
        inFrontMatter = !inFrontMatter;
        if (!inFrontMatter) {
          frontMatterEnded = true;
        }
        continue;
      }
    }

    if (inFrontMatter) {
      // タイトルとタグをfront matterから抽出
      if (line.startsWith('title:')) {
        title = line.substring(6).trim().replace(/^["']|["']$/g, '');
      } else if (line.startsWith('tags:')) {
        const tagsStr = line.substring(5).trim();
        if (tagsStr.startsWith('[') && tagsStr.endsWith(']')) {
          // 配列形式: tags: [tag1, tag2]
          tags.push(...tagsStr.slice(1, -1).split(',').map(t => t.trim().replace(/^["']|["']$/g, '')));
        }
      } else if (line.trim().startsWith('-')) {
        // 配列形式: - tag1
        const tag = line.trim().substring(1).trim().replace(/^["']|["']$/g, '');
        if (tag) tags.push(tag);
      }
      continue;
    }

    // タイトルを # から抽出（front matterがない場合）
    if (!title && line.startsWith('# ')) {
      title = line.substring(2).trim();
      continue;
    }

    // 本文を追加
    if (frontMatterEnded || !line.trim().startsWith('---')) {
      body += line + '\n';
    }
  }

  return {
    title: title || 'Untitled',
    body: body.trim(),
    tags: tags.filter(Boolean),
  };
}

// ─────────────────────────────────────────────────────────
// 本文画像挿入の 3 戦略 (2026-04-25 多戦略対応)
// 戦略: 1. setInputFiles → 2. drop event → 3. clipboard paste
// ─────────────────────────────────────────────────────────

// 戦略 1: hidden file input 経由のアップロード
async function insertImageViaInputFiles(
  page: Page,
  imagePath: string
): Promise<boolean> {
  const hiddenInput = await findHiddenImageInput(page);
  if (!hiddenInput) {
    log('  inputFiles: no hidden input found');
    return false;
  }
  log('  inputFiles: hidden input found, setInputFiles', { imagePath });
  await hiddenInput.setInputFiles(imagePath);
  return true;
}

// 戦略 2: DragEvent injection
async function insertImageViaDrop(
  bodyBox: Locator,
  imagePath: string
): Promise<boolean> {
  const buffer = fs.readFileSync(imagePath);
  const base64 = buffer.toString('base64');
  const ext = path.extname(imagePath).toLowerCase().replace('.', '');
  const mimeType =
    ext === 'png' ? 'image/png' :
    (ext === 'jpg' || ext === 'jpeg') ? 'image/jpeg' :
    ext === 'gif' ? 'image/gif' :
    ext === 'webp' ? 'image/webp' : 'image/png';
  const fileName = path.basename(imagePath);

  const box = await bodyBox.boundingBox();
  if (!box) {
    log('  drop: bodyBox boundingBox null');
    return false;
  }
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;

  return await bodyBox.evaluate(
    (el, args) => {
      try {
        const { base64, mime, fileName, x, y } = args as any;
        const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
        const file = new File([bytes], fileName, { type: mime });
        const dt = new DataTransfer();
        dt.items.add(file);

        const init: any = {
          bubbles: true,
          cancelable: true,
          composed: true,
          clientX: x,
          clientY: y,
          dataTransfer: dt,
        };
        el.dispatchEvent(new DragEvent('dragenter', init));
        el.dispatchEvent(new DragEvent('dragover', init));
        el.dispatchEvent(new DragEvent('drop', init));
        return true;
      } catch (e) {
        console.error('drop dispatch failed', e);
        return false;
      }
    },
    { base64, mime: mimeType, fileName, x, y }
  );
}

// 戦略 3: clipboard paste (既存ロジックの関数化 + エラー伝播)
async function insertImageViaClipboard(ctx: InsertImageContext): Promise<boolean> {
  const { page, imagePath, pasteKey } = ctx;
  const imageBuffer = fs.readFileSync(imagePath);
  const base64Image = imageBuffer.toString('base64');
  const ext = path.extname(imagePath).toLowerCase();
  const mimeType =
    ext === '.png' ? 'image/png' :
    (ext === '.jpg' || ext === '.jpeg') ? 'image/jpeg' :
    ext === '.gif' ? 'image/gif' : 'image/png';

  const writeResult = await page.evaluate(async ({ base64, mime }) => {
    try {
      const response = await fetch(`data:${mime};base64,${base64}`);
      const blob = await response.blob();
      const item = new ClipboardItem({ [mime]: blob });
      await navigator.clipboard.write([item]);
      return { ok: true, blobSize: blob.size };
    } catch (e: any) {
      return { ok: false, error: String(e?.message ?? e) };
    }
  }, { base64: base64Image, mime: mimeType });

  log('  clipboard.write result:', writeResult);
  if (!writeResult.ok) return false;

  await page.waitForTimeout(500);
  await page.keyboard.press(pasteKey);
  await page.waitForTimeout(2000);
  return true;
}

// 画像挿入後 figcaption に alt text を設定 (note の TipTap/ProseMirror 対応)
// Locator.click() + keyboard.type で ProseMirror に確実反映
async function setFigcaption(
  page: Page,
  bodyBox: Locator,
  imageIndex0Based: number,
  caption: string
): Promise<boolean> {
  if (!caption || !caption.trim()) return false;
  try {
    // figcaption を nth-of-type で locate (Playwright Locator API でスクロール+クリック)
    const figcaptionLoc = bodyBox
      .locator('figure')
      .nth(imageIndex0Based)
      .locator('figcaption');

    const exists = await figcaptionLoc.count();
    if (exists === 0) {
      log('  setFigcaption: figcaption locator not found', { idx: imageIndex0Based });
      return false;
    }

    // scroll + click + focus (Playwright が中央クリック + retry を自動処理)
    await figcaptionLoc.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {});
    await figcaptionLoc.click({ timeout: 3000 });
    await page.waitForTimeout(200);

    // キーボード入力 (ProseMirror の input イベント経由で state 同期)
    await page.keyboard.type(caption, { delay: 15 });
    await page.waitForTimeout(300);

    // 確認: figcaption に text が入ったか
    const captionText = await figcaptionLoc.textContent({ timeout: 1000 }).catch(() => '');
    log('  caption confirmed:', { idx: imageIndex0Based, expected: caption, actual: captionText?.trim() });

    // 本文末尾に focus を戻す (次の画像挿入のため必須)
    await bodyBox.click().catch(() => {});
    await page.keyboard.press('End').catch(() => {});
    await page.waitForTimeout(100);

    return (captionText?.trim() === caption.trim());
  } catch (e: any) {
    log('  setFigcaption error:', e?.message);
    // エラーでも focus を戻して次の処理に影響しないようにする
    await bodyBox.click().catch(() => {});
    return false;
  }
}

// メイン: 3 戦略フォールバック + キャプション設定
async function insertInlineImage(ctx: InsertImageContext): Promise<InsertImageResult> {
  const { page, bodyBox, imagePath, imageAlt, imageIndex, totalImages, screenshotDir } = ctx;
  const tag = `[image ${imageIndex}/${totalImages}]`;
  log(`${tag} start`, { imagePath, imageAlt });

  await bodyBox.click().catch(() => {});  // focus 確実化
  await page.waitForTimeout(100);

  const before = await countImages(bodyBox);
  log(`${tag} img count before:`, before);

  // 改行で挿入位置を確保
  await page.keyboard.press('Enter');
  await page.waitForTimeout(300);

  // 共通成功処理: 検証のみ (figcaption は postToNote の最後に一括設定)
  const onSuccess = async (strategy: 'inputFiles' | 'drop' | 'clipboard'): Promise<InsertImageResult> => {
    const after = await countImages(bodyBox);
    log(`${tag} ✓ ${strategy} success`, { before, after });
    return { success: true, strategy, imgCountBefore: before, imgCountAfter: after };
  };

  // === 戦略 1: setInputFiles ===
  try {
    const ok = await insertImageViaInputFiles(page, imagePath);
    if (ok) {
      const success = await waitForImageAdded(bodyBox, before, 8000);
      if (success) return await onSuccess('inputFiles');
      log(`${tag} ✗ inputFiles: img count did not increase`);
    }
  } catch (e: any) {
    log(`${tag} ✗ inputFiles error:`, e?.message);
  }

  // === 戦略 2: drop event ===
  try {
    log(`${tag} → trying drop`);
    const ok = await insertImageViaDrop(bodyBox, imagePath);
    if (ok) {
      const success = await waitForImageAdded(bodyBox, before, 8000);
      if (success) return await onSuccess('drop');
      log(`${tag} ✗ drop: img count did not increase`);
    }
  } catch (e: any) {
    log(`${tag} ✗ drop error:`, e?.message);
  }

  // === 戦略 3: clipboard paste ===
  try {
    log(`${tag} → trying clipboard`);
    const ok = await insertImageViaClipboard(ctx);
    if (ok) {
      const success = await waitForImageAdded(bodyBox, before, 8000);
      if (success) return await onSuccess('clipboard');
      log(`${tag} ✗ clipboard: img count did not increase`);
    }
  } catch (e: any) {
    log(`${tag} ✗ clipboard error:`, e?.message);
  }

  await debugSnapshot(page, screenshotDir, `img${imageIndex}-all-failed`);
  return {
    success: false,
    strategy: 'failed',
    imgCountBefore: before,
    imgCountAfter: before,
    errorMessage: 'All 3 strategies (inputFiles, drop, clipboard) failed',
  };
}

// note.com アクセス解析取得関数
interface NoteArticleStat {
  title: string;
  key: string;
  pv: number;
  likes: number;
  comments: number;
  url: string;
}

interface AnalyticsResult {
  success: boolean;
  period: { start: string; end: string };
  filter: string;
  articles: NoteArticleStat[];
  totalPV: number;
  totalLikes: number;
  totalComments: number;
  articleCount: number;
  fetchedAt: string;
  message: string;
}

async function getAnalytics(params: {
  statePath?: string;
  filter?: string;
  sort?: string;
  limit?: number;
  timeout?: number;
}): Promise<AnalyticsResult> {
  const {
    statePath = DEFAULT_STATE_PATH,
    filter = 'monthly',
    sort = 'pv',
    limit = 10,
    timeout = DEFAULT_TIMEOUT,
  } = params;

  // 認証状態ファイルを確認
  if (!fs.existsSync(statePath)) {
    throw new Error(`State file not found: ${statePath}. Please login first with: npm run login`);
  }

  const validFilters = ['all', 'monthly', 'weekly', 'yearly'];
  if (!validFilters.includes(filter)) {
    throw new Error(`Invalid filter: ${filter}. Must be one of: ${validFilters.join(', ')}`);
  }

  const validSorts = ['pv', 'like', 'comment'];
  if (!validSorts.includes(sort)) {
    throw new Error(`Invalid sort: ${sort}. Must be one of: ${validSorts.join(', ')}`);
  }

  log('Fetching analytics', { filter, sort, limit });

  const browser = await chromium.launch({
    headless: true,
    args: ['--lang=ja-JP'],
  });

  try {
    const context = await browser.newContext({
      storageState: statePath,
      locale: 'ja-JP',
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    });
    const page = await context.newPage();
    page.setDefaultTimeout(timeout);

    // ダッシュボードに遷移（Cookie認証を確立するため）
    await page.goto('https://note.com/sitesettings/stats', { waitUntil: 'domcontentloaded', timeout });

    // ログイン確認
    const currentUrl = page.url();
    if (currentUrl.includes('/login')) {
      await context.close();
      await browser.close();
      throw new Error('Session expired. Please re-login with: npm run login');
    }

    // 内部APIを fetch で全件取得（ページのCookieを使用）
    const allArticles: NoteArticleStat[] = [];
    let pageNum = 1;
    const maxPages = 10; // 安全上限
    let periodStart = '';
    let periodEnd = '';

    while (pageNum <= maxPages) {
      const apiUrl = `/api/v1/stats/pv?filter=${filter}&page=${pageNum}&sort=pv`;
      const apiResult = await page.evaluate(async (url: string) => {
        const res = await fetch(url);
        if (!res.ok) {
          return { error: `API returned ${res.status}`, data: null };
        }
        const json = await res.json();
        return { error: null, data: json.data };
      }, apiUrl);

      if (apiResult.error || !apiResult.data) {
        throw new Error(apiResult.error || 'Failed to fetch analytics data');
      }

      const { note_stats, start_date_str, end_date_str, last_page } = apiResult.data;

      if (pageNum === 1) {
        periodStart = start_date_str;
        periodEnd = end_date_str;
      }

      if (pageNum === 1 && note_stats.length === 0) {
        await context.close();
        await browser.close();
        return {
          success: true,
          period: { start: periodStart, end: periodEnd },
          filter,
          articles: [],
          totalPV: 0,
          totalLikes: 0,
          totalComments: 0,
          articleCount: 0,
          fetchedAt: new Date().toISOString(),
          message: 'No articles found for the selected period',
        };
      }

      for (const stat of note_stats) {
        allArticles.push({
          title: stat.name,
          key: stat.key,
          pv: stat.read_count,
          likes: stat.like_count,
          comments: stat.comment_count,
          url: `https://note.com/${stat.user?.urlname || '01start'}/n/${stat.key}`,
        });
      }

      if (last_page) break;
      pageNum++;
    }

    // クライアント側でソート（API のソートはページ単位のため）
    const sortKey = sort === 'like' ? 'likes' : sort === 'comment' ? 'comments' : 'pv';
    allArticles.sort((a, b) => (b as any)[sortKey] - (a as any)[sortKey]);

    // 全件の合計を算出してから limit で切り詰め
    const totalPV = allArticles.reduce((s, a) => s + a.pv, 0);
    const totalLikes = allArticles.reduce((s, a) => s + a.likes, 0);
    const totalComments = allArticles.reduce((s, a) => s + a.comments, 0);
    const limitedArticles = allArticles.slice(0, limit);

    await context.close();
    await browser.close();

    const result: AnalyticsResult = {
      success: true,
      period: { start: periodStart, end: periodEnd },
      filter,
      articles: limitedArticles,
      totalPV,
      totalLikes,
      totalComments,
      articleCount: limitedArticles.length,
      fetchedAt: new Date().toISOString(),
      message: `Top ${limitedArticles.length} of ${allArticles.length} articles (${filter}, sorted by ${sort})`,
    };

    log('Analytics fetched', { articleCount: allArticles.length, totalPV, totalLikes });
    return result;
  } catch (error) {
    await browser.close();
    throw error;
  }
}

// 競合 note クリエイター分析関数
interface CompetitorArticle {
  title: string;
  key: string;
  likes: number;
  comments: number;
  publishedAt: string;
  url: string;
  hashtags: string[];
  bodyPreview: string;
}

interface CompetitorResult {
  success: boolean;
  creator: string;
  creatorName: string;
  articles: CompetitorArticle[];
  totalArticles: number;
  avgLikes: number;
  avgComments: number;
  topHashtags: { tag: string; count: number }[];
  fetchedAt: string;
  message: string;
}

async function analyzeCompetitor(params: {
  creator: string;
  limit?: number;
  timeout?: number;
}): Promise<CompetitorResult> {
  const {
    creator,
    limit = 20,
    timeout = 30000,
  } = params;

  log('Analyzing competitor', { creator, limit });

  const allArticles: CompetitorArticle[] = [];
  let creatorName = creator;
  let page = 1;
  const perPage = 20;
  const maxPages = Math.ceil(limit / perPage);

  while (page <= maxPages) {
    const apiUrl = `https://note.com/api/v2/creators/${encodeURIComponent(creator)}/contents?kind=note&page=${page}&per_page=${perPage}`;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    try {
      const res = await fetch(apiUrl, {
        signal: controller.signal,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
          'Accept': 'application/json',
        },
      });
      clearTimeout(timeoutId);

      if (!res.ok) {
        if (res.status === 404) {
          throw new Error(`Creator not found: ${creator}`);
        }
        throw new Error(`API returned ${res.status}`);
      }

      const json = await res.json();
      const contents = json.data?.contents ?? [];

      if (contents.length === 0) break;

      // クリエイター名を取得（最初のページのみ）
      if (page === 1 && contents[0]?.user?.nickname) {
        creatorName = contents[0].user.nickname;
      }

      for (const item of contents) {
        allArticles.push({
          title: item.name || 'Untitled',
          key: item.key || '',
          likes: item.likeCount || 0,
          comments: item.commentCount || 0,
          publishedAt: item.publishAt || '',
          url: item.noteUrl || `https://note.com/${creator}/n/${item.key}`,
          hashtags: (item.hashtags || []).map((h: any) => h.hashtag?.name || h.name || String(h)),
          bodyPreview: (item.body || '').substring(0, 200),
        });
      }

      // 最後のページに達したか
      if (contents.length < perPage) break;
      page++;
    } catch (error) {
      clearTimeout(timeoutId);
      if ((error as Error).name === 'AbortError') {
        throw new Error(`Timeout fetching creator: ${creator}`);
      }
      throw error;
    }
  }

  // limit で切り詰め
  const limited = allArticles.slice(0, limit);

  // 統計計算
  const avgLikes = limited.length > 0
    ? Math.round(limited.reduce((s, a) => s + a.likes, 0) / limited.length)
    : 0;
  const avgComments = limited.length > 0
    ? Math.round(limited.reduce((s, a) => s + a.comments, 0) / limited.length)
    : 0;

  // トップハッシュタグ集計
  const tagCounts = new Map<string, number>();
  for (const article of limited) {
    for (const tag of article.hashtags) {
      tagCounts.set(tag, (tagCounts.get(tag) || 0) + 1);
    }
  }
  const topHashtags = Array.from(tagCounts.entries())
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);

  const result: CompetitorResult = {
    success: true,
    creator,
    creatorName,
    articles: limited,
    totalArticles: limited.length,
    avgLikes,
    avgComments,
    topHashtags,
    fetchedAt: new Date().toISOString(),
    message: `Fetched ${limited.length} articles from ${creatorName} (@${creator})`,
  };

  log('Competitor analysis complete', { creator, articleCount: limited.length, avgLikes });
  return result;
}

// note.com投稿関数
async function postToNote(params: {
  markdownPath: string;
  thumbnailPath?: string;
  statePath?: string;
  isPublic: boolean;
  screenshotDir?: string;
  timeout?: number;
}): Promise<{
  success: boolean;
  url: string;
  screenshot?: string;
  message: string;
  imageStats?: { expected: number; actual: number };
}> {
  const {
    markdownPath,
    thumbnailPath,
    statePath = DEFAULT_STATE_PATH,
    isPublic,
    screenshotDir = path.join(os.tmpdir(), 'note-screenshots'),
    timeout = DEFAULT_TIMEOUT,
  } = params;

  // Markdownファイルを読み込み
  if (!fs.existsSync(markdownPath)) {
    throw new Error(`Markdown file not found: ${markdownPath}`);
  }
  const mdContent = fs.readFileSync(markdownPath, 'utf-8');
  const { title, body, tags } = parseMarkdown(mdContent);
  
  // 本文中の画像を抽出
  const baseDir = path.dirname(markdownPath);
  const images = extractImages(body, baseDir);

  log('Parsed markdown', { title, bodyLength: body.length, tags, imageCount: images.length });

  // 認証状態ファイルを確認
  if (!fs.existsSync(statePath)) {
    throw new Error(`State file not found: ${statePath}. Please login first.`);
  }

  // スクリーンショットディレクトリを作成
  fs.mkdirSync(screenshotDir, { recursive: true });
  const screenshotPath = path.join(screenshotDir, `note-post-${nowStr()}.png`);

  const browser = await chromium.launch({
    headless: true,
    args: ['--lang=ja-JP'],
  });

  try {
    const context = await browser.newContext({
      storageState: statePath,
      locale: 'ja-JP',
      permissions: ['clipboard-read', 'clipboard-write'],
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    });
    const page = await context.newPage();
    page.setDefaultTimeout(timeout);
    
    // クリップボード権限を明示的に付与
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: 'https://editor.note.com' });

    // 新規記事作成ページに移動
    const startUrl = 'https://editor.note.com/new';
    await page.goto(startUrl, { waitUntil: 'domcontentloaded', timeout });
    await page.waitForSelector('textarea[placeholder*="タイトル"]', { timeout });

    // サムネイル画像の設定
    if (thumbnailPath && fs.existsSync(thumbnailPath)) {
      log('Uploading thumbnail image');
      const candidates = page.locator('button[aria-label="画像を追加"]');
      await candidates.first().waitFor({ state: 'visible', timeout });

      let target = candidates.first();
      const cnt = await candidates.count();
      if (cnt > 1) {
        let minY = Infinity;
        let idx = 0;
        for (let i = 0; i < cnt; i++) {
          const box = await candidates.nth(i).boundingBox();
          if (box && box.y < minY) {
            minY = box.y;
            idx = i;
          }
        }
        target = candidates.nth(idx);
      }

      await target.scrollIntoViewIfNeeded();
      await target.click({ force: true });

      const uploadBtn = page.locator('button:has-text("画像をアップロード")').first();
      await uploadBtn.waitFor({ state: 'visible', timeout });

      let chooser = null;
      try {
        [chooser] = await Promise.all([
          page.waitForEvent('filechooser', { timeout: 5000 }),
          uploadBtn.click({ force: true }),
        ]);
      } catch (_) {
        // フォールバック
      }

      if (chooser) {
        await chooser.setFiles(thumbnailPath);
      } else {
        await uploadBtn.click({ force: true }).catch(() => {});
        const fileInput = page.locator('input[type="file"]').first();
        await fileInput.waitFor({ state: 'attached', timeout });
        await fileInput.setInputFiles(thumbnailPath);
      }

      // トリミングダイアログ内「保存」を押す
      const dialog = page.locator('div[role="dialog"]');
      await dialog.waitFor({ state: 'visible', timeout });

      const saveThumbBtn = dialog.locator('button:has-text("保存")').first();
      const cropper = dialog.locator('[data-testid="cropper"]').first();

      const cropperEl = await cropper.elementHandle();
      const saveEl = await saveThumbBtn.elementHandle();

      if (cropperEl && saveEl) {
        await Promise.race([
          page.waitForFunction(
            (el) => getComputedStyle(el as Element).pointerEvents === 'none',
            cropperEl,
            { timeout }
          ),
          page.waitForFunction(
            (el) => !(el as HTMLButtonElement).disabled,
            saveEl,
            { timeout }
          ),
        ]);
      }

      await saveThumbBtn.click();
      await dialog.waitFor({ state: 'hidden', timeout }).catch(() => {});
      await page.waitForLoadState('networkidle', { timeout }).catch(() => {});

      // 反映確認
      const changedBtn = page.locator('button[aria-label="画像を変更"]');
      const addBtn = page.locator('button[aria-label="画像を追加"]');

      let applied = false;
      try {
        await changedBtn.waitFor({ state: 'visible', timeout: 5000 });
        applied = true;
      } catch {}
      if (!applied) {
        try {
          await addBtn.waitFor({ state: 'hidden', timeout: 5000 });
          applied = true;
        } catch {}
      }
      if (!applied) {
        log('Thumbnail reflection uncertain, continuing');
      }
    }

    // タイトル設定
    await page.fill('textarea[placeholder*="タイトル"]', title);
    log('Title set');

    // 本文設定（チャンク分割クリップボード貼り付け方式）
    // 通常テキストをまとめてクリップボード→Cmd+Vで一括貼り付けし、
    // 特殊行（URL、画像、コードブロック）のみ個別処理する。
    const bodyBox = page.locator('div[contenteditable="true"][role="textbox"]').first();
    await bodyBox.waitFor({ state: 'visible' });
    await bodyBox.click();

    const lines = body.split('\n');
    const isMac = process.platform === 'darwin';
    const pasteKey = isMac ? 'Meta+v' : 'Control+v';
    const CHUNK_SIZE = 50; // 50行ずつまとめて貼り付け

    // ヘルパー: テキストチャンクをクリップボード経由で貼り付け
    const pasteChunk = async (text: string) => {
      if (!text) return;
      await page.evaluate((t) => navigator.clipboard.writeText(t), text);
      await page.waitForTimeout(100);
      await page.keyboard.press(pasteKey);
      await page.waitForTimeout(200);
    };

    let buffer: string[] = []; // 通常テキスト行のバッファ

    // バッファをフラッシュ（まとめて貼り付け）
    const flushBuffer = async () => {
      if (buffer.length === 0) return;
      const text = buffer.join('\n');
      await pasteChunk(text);
      buffer = [];
    };

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const isLastLine = i === lines.length - 1;

      // コードブロック: まとめてクリップボード貼り付け
      if (line.trim().startsWith('```')) {
        await flushBuffer();
        const codeBlockLines: string[] = [line];
        let j = i + 1;
        while (j < lines.length) {
          codeBlockLines.push(lines[j]);
          if (lines[j].trim().startsWith('```')) break;
          j++;
        }
        await pasteChunk(codeBlockLines.join('\n'));
        if (j < lines.length - 1) await page.keyboard.press('Enter');
        i = j;
        continue;
      }

      // 画像マークダウン: 個別処理 (2026-04-25 多戦略フォールバック)
      const imageMatch = line.match(/!\[([^\]]*)\]\(([^)]+)\)/);
      if (imageMatch) {
        const imagePath = imageMatch[2];
        if (!imagePath.startsWith('http://') && !imagePath.startsWith('https://')) {
          const imageInfo = images.find(img => img.localPath === imagePath);
          if (imageInfo && fs.existsSync(imageInfo.absolutePath)) {
            await flushBuffer();
            const result = await insertInlineImage({
              page,
              bodyBox,
              imagePath: imageInfo.absolutePath,
              imageAlt: imageInfo.alt || '',  // figcaption に挿入
              imageIndex: images.indexOf(imageInfo) + 1,
              totalImages: images.length,
              screenshotDir,
              isMac,
              pasteKey,
            });
            log('insertInlineImage result', result);
            if (!result.success) {
              // テキスト fallback
              await pasteChunk(`[image: ${path.basename(imageInfo.absolutePath)}]`);
            }
            if (!isLastLine) await page.keyboard.press('Enter');
            continue;
          }
        }
      }

      // URL単独行: フラッシュしてからURLを入力→リンクカード化
      const isUrlLine = /^https?:\/\/[^\s]+$/.test(line.trim());
      if (isUrlLine) {
        await flushBuffer();
        await page.keyboard.type(line);
        await page.keyboard.press('Enter');
        await page.waitForTimeout(1200);
        if (!isLastLine) {
          await page.keyboard.press('ArrowDown');
          await page.waitForTimeout(150);
        }
        continue;
      }

      // 通常行: バッファに追加
      buffer.push(line);

      // CHUNK_SIZE行ごとにフラッシュ（最後の行も含む）
      if (buffer.length >= CHUNK_SIZE || isLastLine) {
        await flushBuffer();
        // チャンク間で少し待機（エディタの処理時間）
        if (!isLastLine) {
          await page.waitForTimeout(300);
        }
      }
    }

    // 残りのバッファをフラッシュ
    await flushBuffer();

    // 画像挿入結果の検証ログ (2026-04-25)
    const totalImagesInDOM = await countImages(bodyBox);
    log('Body set', { totalImagesInDOM, expectedImages: images.length });
    if (images.length > 0 && totalImagesInDOM < images.length) {
      log('WARNING: image count mismatch', {
        expected: images.length,
        actual: totalImagesInDOM,
        missing: images.length - totalImagesInDOM,
      });
      await debugSnapshot(page, screenshotDir, 'final-mismatch');
    }

    // 一括 figcaption 設定 (本文ループ後、画像挿入を妨げないため最後に実施)
    if (totalImagesInDOM > 0) {
      let captionsSet = 0;
      for (let i = 0; i < Math.min(totalImagesInDOM, images.length); i++) {
        const alt = images[i]?.alt || '';
        if (alt && alt.trim() && alt !== 'image') {
          const ok = await setFigcaption(page, bodyBox, i, alt);
          if (ok) captionsSet++;
        }
      }
      log('Captions set', { total: totalImagesInDOM, applied: captionsSet });
    }

    // 下書き保存の場合
    if (!isPublic) {
      const saveBtn = page.locator('button:has-text("下書き保存"), [aria-label*="下書き保存"]').first();
      await saveBtn.waitFor({ state: 'visible', timeout });
      if (await saveBtn.isEnabled()) {
        await saveBtn.click();
        await page.locator('text=保存しました').waitFor({ timeout: 4000 }).catch(() => {});
        await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
      }

      await page.screenshot({ path: screenshotPath, fullPage: true });
      const finalUrl = page.url();
      log('Draft saved', { url: finalUrl });

      await context.close();
      await browser.close();

      return {
        success: true,
        url: finalUrl,
        screenshot: screenshotPath,
        message: '下書きを保存しました',
        imageStats: {
          expected: images.length,
          actual: totalImagesInDOM,
        },
      };
    }

    // 公開に進む
    const proceedBtn = page.locator('button:has-text("公開に進む")').first();
    await proceedBtn.waitFor({ state: 'visible', timeout });
    for (let i = 0; i < 20; i++) {
      if (await proceedBtn.isEnabled()) break;
      await page.waitForTimeout(100);
    }
    await proceedBtn.click({ force: true });

    // 公開ページへ遷移
    await Promise.race([
      page.waitForURL(/\/publish/i, { timeout }).catch(() => {}),
      page.locator('button:has-text("投稿する")').first().waitFor({ state: 'visible', timeout }).catch(() => {}),
    ]);

    // タグ入力
    if (tags.length > 0) {
      log('Adding tags', { tags });
      let tagInput = page.locator('input[placeholder*="ハッシュタグ"]');
      if (!(await tagInput.count())) {
        tagInput = page.locator('input[role="combobox"]').first();
      }
      await tagInput.waitFor({ state: 'visible', timeout });
      for (const tag of tags) {
        await tagInput.click();
        await tagInput.fill(tag);
        await page.keyboard.press('Enter');
        await page.waitForTimeout(120);
      }
    }

    // 投稿する
    const publishBtn = page.locator('button:has-text("投稿する")').first();
    await publishBtn.waitFor({ state: 'visible', timeout });
    for (let i = 0; i < 20; i++) {
      if (await publishBtn.isEnabled()) break;
      await page.waitForTimeout(100);
    }
    await publishBtn.click({ force: true });

    // 投稿完了待ち
    await Promise.race([
      page.waitForURL((url) => !/\/publish/i.test(url.toString()), { timeout: 20000 }).catch(() => {}),
      page.locator('text=投稿しました').first().waitFor({ timeout: 8000 }).catch(() => {}),
      page.waitForTimeout(5000),
    ]);

    await page.screenshot({ path: screenshotPath, fullPage: true });
    const finalUrl = page.url();
    log('Published', { url: finalUrl });

    await context.close();
    await browser.close();

    return {
      success: true,
      url: finalUrl,
      screenshot: screenshotPath,
      message: '記事を公開しました',
      imageStats: {
        expected: images.length,
        actual: totalImagesInDOM,
      },
    };
  } catch (error) {
    await browser.close();
    throw error;
  }
}

// Zodスキーマ定義
const PublishNoteSchema = z.object({
  markdown_path: z.string().describe('Markdownファイルのパス（タイトル、本文、タグを含む）'),
  thumbnail_path: z.string().optional().describe('サムネイル画像のパス（オプション）'),
  state_path: z.string().optional().describe(`note.comの認証状態ファイルのパス（デフォルト: ${DEFAULT_STATE_PATH}）`),
  screenshot_dir: z.string().optional().describe('スクリーンショット保存ディレクトリ（オプション）'),
  timeout: z.number().optional().describe(`タイムアウト（ミリ秒、デフォルト: ${DEFAULT_TIMEOUT}）`),
});

const GetAnalyticsSchema = z.object({
  state_path: z.string().optional().describe(`note.comの認証状態ファイルのパス（デフォルト: ${DEFAULT_STATE_PATH}）`),
  filter: z.enum(['all', 'monthly', 'weekly', 'yearly']).optional().describe('期間フィルタ（デフォルト: monthly）'),
  sort: z.enum(['pv', 'like', 'comment']).optional().describe('ソート順（デフォルト: pv）'),
  limit: z.number().optional().describe('取得する記事数の上限（デフォルト: 10）'),
  timeout: z.number().optional().describe(`タイムアウト（ミリ秒、デフォルト: ${DEFAULT_TIMEOUT}）`),
});

const AnalyzeCompetitorSchema = z.object({
  creator: z.string().describe('note.comのクリエイター名（URLの https://note.com/{creator} 部分）'),
  limit: z.number().optional().describe('取得する記事数の上限（デフォルト: 20）'),
  timeout: z.number().optional().describe('タイムアウト（ミリ秒、デフォルト: 30000）'),
});

const SaveDraftSchema = z.object({
  markdown_path: z.string().describe('Markdownファイルのパス（タイトル、本文、タグを含む）'),
  thumbnail_path: z.string().optional().describe('サムネイル画像のパス（オプション）'),
  state_path: z.string().optional().describe(`note.comの認証状態ファイルのパス（デフォルト: ${DEFAULT_STATE_PATH}）`),
  screenshot_dir: z.string().optional().describe('スクリーンショット保存ディレクトリ（オプション）'),
  timeout: z.number().optional().describe(`タイムアウト（ミリ秒、デフォルト: ${DEFAULT_TIMEOUT}）`),
});

// ツール定義
const TOOLS: Tool[] = [
  {
    name: 'get_analytics',
    description: 'note.comのアクセス解析データを取得します。記事別PV・スキ数・コメント数を期間指定で取得できます。',
    inputSchema: {
      type: 'object',
      properties: {
        state_path: {
          type: 'string',
          description: `note.comの認証状態ファイルのパス（デフォルト: ${DEFAULT_STATE_PATH}）`,
        },
        filter: {
          type: 'string',
          enum: ['all', 'monthly', 'weekly', 'yearly'],
          description: '期間フィルタ: all=全期間, monthly=月間, weekly=週間, yearly=年間（デフォルト: monthly）',
        },
        sort: {
          type: 'string',
          enum: ['pv', 'like', 'comment'],
          description: 'ソート順（デフォルト: pv）',
        },
        limit: {
          type: 'number',
          description: '取得する記事数の上限（デフォルト: 10）',
        },
        timeout: {
          type: 'number',
          description: `タイムアウト（ミリ秒、デフォルト: ${DEFAULT_TIMEOUT}）`,
        },
      },
    },
  },
  {
    name: 'publish_note',
    description: 'note.comに記事を公開します。Markdownファイルからタイトル、本文、タグを読み取り、自動的に投稿します。',
    inputSchema: {
      type: 'object',
      properties: {
        markdown_path: {
          type: 'string',
          description: 'Markdownファイルのパス（タイトル、本文、タグを含む）',
        },
        thumbnail_path: {
          type: 'string',
          description: 'サムネイル画像のパス（オプション）',
        },
        state_path: {
          type: 'string',
          description: `note.comの認証状態ファイルのパス（デフォルト: ${DEFAULT_STATE_PATH}）`,
        },
        screenshot_dir: {
          type: 'string',
          description: 'スクリーンショット保存ディレクトリ（オプション）',
        },
        timeout: {
          type: 'number',
          description: `タイムアウト（ミリ秒、デフォルト: ${DEFAULT_TIMEOUT}）`,
        },
      },
      required: ['markdown_path'],
    },
  },
  {
    name: 'analyze_competitor',
    description: '競合のnote.comクリエイターの記事一覧を取得・分析します。記事タイトル、スキ数、コメント数、ハッシュタグ、公開日を取得し、トップハッシュタグや平均エンゲージメントを算出します。認証不要（公開API使用）。',
    inputSchema: {
      type: 'object',
      properties: {
        creator: {
          type: 'string',
          description: 'note.comのクリエイター名（URLの https://note.com/{creator} 部分）',
        },
        limit: {
          type: 'number',
          description: '取得する記事数の上限（デフォルト: 20）',
        },
        timeout: {
          type: 'number',
          description: 'タイムアウト（ミリ秒、デフォルト: 30000）',
        },
      },
      required: ['creator'],
    },
  },
  {
    name: 'save_draft',
    description: 'note.comに下書きを保存します。Markdownファイルからタイトル、本文、タグを読み取り、下書きとして保存します。',
    inputSchema: {
      type: 'object',
      properties: {
        markdown_path: {
          type: 'string',
          description: 'Markdownファイルのパス（タイトル、本文、タグを含む）',
        },
        thumbnail_path: {
          type: 'string',
          description: 'サムネイル画像のパス（オプション）',
        },
        state_path: {
          type: 'string',
          description: `note.comの認証状態ファイルのパス（デフォルト: ${DEFAULT_STATE_PATH}）`,
        },
        screenshot_dir: {
          type: 'string',
          description: 'スクリーンショット保存ディレクトリ（オプション）',
        },
        timeout: {
          type: 'number',
          description: `タイムアウト（ミリ秒、デフォルト: ${DEFAULT_TIMEOUT}）`,
        },
      },
      required: ['markdown_path'],
    },
  },
];

// MCPサーバーの初期化
const server = new Server(
  {
    name: SERVER_NAME,
    version: SERVER_VERSION,
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// ツール一覧ハンドラ
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS,
}));

// ツール呼び出しハンドラ
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    if (name === 'get_analytics') {
      const params = GetAnalyticsSchema.parse(args);
      const result = await getAnalytics({
        statePath: params.state_path,
        filter: params.filter,
        sort: params.sort,
        limit: params.limit,
        timeout: params.timeout,
      });
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    }

    if (name === 'analyze_competitor') {
      const params = AnalyzeCompetitorSchema.parse(args);
      const result = await analyzeCompetitor({
        creator: params.creator,
        limit: params.limit,
        timeout: params.timeout,
      });
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    }

    if (name === 'publish_note') {
      const params = PublishNoteSchema.parse(args);
      const result = await postToNote({
        markdownPath: params.markdown_path,
        thumbnailPath: params.thumbnail_path,
        statePath: params.state_path,
        screenshotDir: params.screenshot_dir,
        timeout: params.timeout,
        isPublic: true,
      });
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    }

    if (name === 'save_draft') {
      const params = SaveDraftSchema.parse(args);
      const result = await postToNote({
        markdownPath: params.markdown_path,
        thumbnailPath: params.thumbnail_path,
        statePath: params.state_path,
        screenshotDir: params.screenshot_dir,
        timeout: params.timeout,
        isPublic: false,
      });
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    }

    throw new Error(`Unknown tool: ${name}`);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    log('Tool execution error', { name, error: errorMessage });
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              success: false,
              error: errorMessage,
            },
            null,
            2
          ),
        },
      ],
      isError: true,
    };
  }
});

// サーバー起動
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  log('Server started', { name: SERVER_NAME, version: SERVER_VERSION });
}

main().catch((error) => {
  log('Fatal error', error);
  process.exit(1);
});


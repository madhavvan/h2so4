// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  DOCUMENTATION — full-screen in-app reference
//
//  Bundles every .md in /docs (plus README.md) at build time via
//  Vite's ?raw import. Renders a Stripe/Linear/Vercel-style three-
//  column layout: doc list (left), markdown content (center),
//  scrollspy TOC (right). Cross-doc links route internally; external
//  links go through electronAPI.openExternal so they open in the OS
//  browser. Code blocks use react-syntax-highlighter (Prism) with a
//  theme that flips on settings.theme.
//
//  Docs ship inside the asar — no network round-trip, instant doc
//  switches, works offline, version-locked to the installed build
//  (every auto-update carries the docs from that release).
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { vscDarkPlus, oneLight } from 'react-syntax-highlighter/dist/esm/styles/prism';
import {
  Book,
  Search,
  X,
  ChevronRight,
  Shield,
  CreditCard,
  Github,
  ArrowUpRight,
  Hash,
  Menu,
  HelpCircle,
  Sparkles,
  Wrench,
  Lock,
  FileText,
} from 'lucide-react';

// ──────────────────────────────────────────────────────────────────
// RAW MARKDOWN IMPORTS — bundled at build time
// Vite's ?raw query inlines the file as a string. Each release
// rebuilds; auto-updater carries fresh docs to every installed client.
//
// CRITICAL: only files from /docs/public/ are imported here. The
// engineering docs at /docs/{ARCHITECTURE,AUTO_TYPE,PROMPTS,SERVER,
// RUNBOOK,BUILD}.md are internal team references — they reveal the
// stealth architecture, anti-detection playbook, the prompt-moat,
// and backend internals. Bundling them into the public website
// would hand competitors a copy of the moat and hand anti-cheat
// vendors a shopping list of evasions to target. /docs/public/ is
// the deliberate, narrow user-facing surface.
// ──────────────────────────────────────────────────────────────────

import gettingStartedRaw from './docs/public/GETTING_STARTED.md?raw';
import featuresRaw from './docs/public/FEATURES.md?raw';
import faqRaw from './docs/public/FAQ.md?raw';
import troubleshootingRaw from './docs/public/TROUBLESHOOTING.md?raw';
import securityRaw from './docs/public/SECURITY.md?raw';
import privacyRaw from './docs/public/PRIVACY.md?raw';
import tiersRaw from './docs/public/TIERS.md?raw';

// ──────────────────────────────────────────────────────────────────
// TYPES + REGISTRY
// ──────────────────────────────────────────────────────────────────

type DocCategory = 'Start here' | 'Reference' | 'Trust' | 'Plans' | 'Internal';

interface DocEntry {
  slug: string;
  title: string;
  summary: string;
  category: DocCategory;
  icon: React.ReactNode;
  raw: string;
  /** Source file path on disk — drives the Edit-on-GitHub link. */
  sourcePath: string;
  /** Admin-only: this doc came from /api/v1/support/admin-docs and is
   *  decrypted server-side. Visible only when admin is authenticated.
   *  Excluded from the public ⌘K search index. */
  isInternal?: boolean;
}

interface TocEntry {
  /** Section number, e.g. "3" for "## 3. Window construction". Empty for unnumbered. */
  number: string;
  title: string;
  /** GitHub-flavored slug, matches the in-doc anchor links. */
  anchor: string;
}

const ICON_PROPS = { size: 16, strokeWidth: 1.5 } as const;

const DOC_REGISTRY: DocEntry[] = [
  {
    slug: 'getting-started',
    title: 'Getting started',
    summary: 'Install, sign in, drop in your résumé, run your first interview session.',
    category: 'Start here',
    icon: <Book {...ICON_PROPS} />,
    raw: gettingStartedRaw,
    sourcePath: 'docs/public/GETTING_STARTED.md',
  },
  {
    slug: 'features',
    title: 'Features',
    summary: 'Every feature in the app, explained at user level.',
    category: 'Reference',
    icon: <Sparkles {...ICON_PROPS} />,
    raw: featuresRaw,
    sourcePath: 'docs/public/FEATURES.md',
  },
  {
    slug: 'faq',
    title: 'FAQ',
    summary: 'Quick answers to questions we hear most.',
    category: 'Reference',
    icon: <HelpCircle {...ICON_PROPS} />,
    raw: faqRaw,
    sourcePath: 'docs/public/FAQ.md',
  },
  {
    slug: 'troubleshooting',
    title: 'Troubleshooting',
    summary: 'Step-by-step fixes for the issues we hear about most.',
    category: 'Reference',
    icon: <Wrench {...ICON_PROPS} />,
    raw: troubleshootingRaw,
    sourcePath: 'docs/public/TROUBLESHOOTING.md',
  },
  {
    slug: 'security',
    title: 'Security',
    summary: 'Trust claims for evaluators — what the desktop app does and does not do.',
    category: 'Trust',
    icon: <Shield {...ICON_PROPS} />,
    raw: securityRaw,
    sourcePath: 'docs/public/SECURITY.md',
  },
  {
    slug: 'privacy',
    title: 'Privacy policy',
    summary: 'What we collect, why, third-party processors, your rights.',
    category: 'Trust',
    icon: <Shield {...ICON_PROPS} />,
    raw: privacyRaw,
    sourcePath: 'docs/public/PRIVACY.md',
  },
  {
    slug: 'tiers',
    title: 'Tiers & billing',
    summary: 'What each plan unlocks, pricing by region, refunds, cancellation.',
    category: 'Plans',
    icon: <CreditCard {...ICON_PROPS} />,
    raw: tiersRaw,
    sourcePath: 'docs/public/TIERS.md',
  },
];

const CATEGORY_ORDER: DocCategory[] = ['Start here', 'Reference', 'Trust', 'Plans', 'Internal'];

// Slugifier used to derive a stable URL slug for runtime-loaded admin
// docs. ARCHITECTURE.md → 'admin-architecture', AUTO_TYPE.md → 'admin-auto-type'.
// Prefixed with 'admin-' to avoid collisions with public slugs and to make
// it obvious in the URL bar when an admin doc is being viewed.
function adminDocSlugFor(filename: string): string {
  return 'admin-' + filename
    .replace(/\.md$/i, '')
    .toLowerCase()
    .replace(/[_\s]+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

function prettyAdminTitle(filename: string): string {
  // ARCHITECTURE.md → 'Architecture', AUTO_TYPE.md → 'Auto-type'
  const base = filename.replace(/\.md$/i, '');
  return base
    .toLowerCase()
    .split(/[_\s]+/)
    .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
    .join('-');
}

// Public releases/issues repo — the app source lives in a private repo, so
// user-facing links (doc feedback, issue reports) go here. Do NOT point this
// at the source repo: it 404s for users once the source goes private.
const GITHUB_REPO = 'https://github.com/madhavvan/interviewcopilot-releases';

// ──────────────────────────────────────────────────────────────────
// HELPERS
// ──────────────────────────────────────────────────────────────────

/**
 * GitHub-flavored heading slug: lowercase, drop punctuation except
 * hyphens, collapse whitespace to single hyphen. Matches the anchors
 * the in-doc TOCs already use (e.g. "## 7. Auto-update flow" →
 * "#7-auto-update-flow"). Keep the regex narrow — the docs include
 * ampersands ("Build & Release"), slashes ("AppImage / DEB"), and
 * parens that we want to drop without leaving stray hyphens.
 */
function slugify(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[`*_~]/g, '')
    .replace(/[.,/&():]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

/**
 * Walk the raw markdown for `## ` headings (h2). The TOC rail mirrors
 * exactly these so the "you are here" scrollspy state matches the
 * sections the user can scroll to. Skip headings inside fenced code
 * blocks ("```").
 */
function extractToc(raw: string): TocEntry[] {
  const out: TocEntry[] = [];
  const lines = raw.split('\n');
  let inFence = false;
  for (const line of lines) {
    if (/^```/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const m = /^##\s+(.+?)\s*$/.exec(line);
    if (!m) continue;
    const title = m[1].trim();
    // Detect numbered "1. Foo" prefix so the rail can render the
    // number as a tag and the title separately.
    const numMatch = /^(\d+)\.\s+(.+)$/.exec(title);
    const number = numMatch ? numMatch[1] : '';
    const display = numMatch ? numMatch[2] : title;
    out.push({
      number,
      title: display,
      anchor: slugify(title),
    });
  }
  return out;
}

/** Pre-extract every TOC at module load; ~100 entries total, cheap. */
const DOC_TOCS: Record<string, TocEntry[]> = Object.fromEntries(
  DOC_REGISTRY.map((d) => [d.slug, extractToc(d.raw)]),
);

/** Flat list for the search palette. */
interface SearchEntry {
  docSlug: string;
  docTitle: string;
  toc: TocEntry;
}
const SEARCH_INDEX: SearchEntry[] = DOC_REGISTRY.flatMap((d) =>
  DOC_TOCS[d.slug].map((t) => ({ docSlug: d.slug, docTitle: d.title, toc: t })),
);

/** React node → plain text (for heading IDs when children include code/em). */
function nodeText(node: React.ReactNode): string {
  if (node == null || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(nodeText).join('');
  if (React.isValidElement(node)) return nodeText((node.props as { children?: React.ReactNode }).children);
  return '';
}

/**
 * Decide where a link should go. Returns:
 *   { kind: 'doc', slug, anchor? } — switch active doc
 *   { kind: 'anchor', anchor }     — same-doc scroll
 *   { kind: 'external', url }      — open in OS browser
 *   { kind: 'noop' }               — empty href etc.
 */
type LinkTarget =
  | { kind: 'doc'; slug: string; anchor?: string }
  | { kind: 'anchor'; anchor: string }
  | { kind: 'external'; url: string }
  | { kind: 'noop' };

// Cross-doc filename → slug map. Only the four public docs are listed;
// any link in the markdown to one of the internal engineering files
// (ARCHITECTURE.md, AUTO_TYPE.md, etc.) will fall through to the GitHub
// source-link branch in resolveLink and open the file on github.com
// rather than try to render it inside the public viewer.
const SLUG_BY_FILENAME: Record<string, string> = {
  'GETTING_STARTED.md': 'getting-started',
  'SECURITY.md': 'security',
  'PRIVACY.md': 'privacy',
  'TIERS.md': 'tiers',
};

function resolveLink(href: string): LinkTarget {
  if (!href) return { kind: 'noop' };
  // Pure anchor on the current doc.
  if (href.startsWith('#')) return { kind: 'anchor', anchor: href.slice(1) };
  // Cross-doc relative link, optionally with #anchor.
  // Match either ./FOO.md or ../FOO.md (no path traversal beyond one level).
  const m = /^\.{1,2}\/([A-Z_-]+\.md)(?:#(.+))?$/.exec(href);
  if (m) {
    const filename = m[1];
    const anchor = m[2];
    const slug = SLUG_BY_FILENAME[filename];
    if (slug) return { kind: 'doc', slug, anchor };
    // Unknown .md (shouldn't happen), fall through to GitHub.
  }
  // Repo-relative source link (e.g. ../services/aiProxyService.ts) — open
  // the file on GitHub. We're not going to render TS in the doc viewer.
  if (/^\.\.\//.test(href)) {
    const cleaned = href.replace(/^\.\.\//, '');
    return { kind: 'external', url: `${GITHUB_REPO}/blob/main/${cleaned}` };
  }
  // mailto / tel / data — let the OS handle.
  if (/^(mailto:|tel:|data:)/.test(href)) return { kind: 'external', url: href };
  // Absolute URL.
  if (/^https?:\/\//.test(href)) return { kind: 'external', url: href };
  // Anything else — best effort: treat as anchor.
  return { kind: 'anchor', anchor: href };
}

/** Open URL in OS browser via the preload bridge, falling back to window.open. */
function openExternal(url: string) {
  const api = (window as unknown as { electronAPI?: { openExternalRobust?: (u: string) => Promise<unknown>; openExternal?: (u: string) => Promise<unknown> } }).electronAPI;
  if (api?.openExternalRobust) {
    void api.openExternalRobust(url).catch(() => api.openExternal?.(url));
  } else if (api?.openExternal) {
    void api.openExternal(url);
  } else {
    window.open(url, '_blank', 'noopener,noreferrer');
  }
}

// ──────────────────────────────────────────────────────────────────
// MARKDOWN RENDERER COMPONENTS
// ──────────────────────────────────────────────────────────────────

interface CodeBlockProps {
  className?: string;
  children?: React.ReactNode;
  inline?: boolean;
  isDark: boolean;
}

const CodeBlock: React.FC<CodeBlockProps> = ({ className, children, inline, isDark }) => {
  const text = String(children ?? '').replace(/\n$/, '');
  if (inline) {
    return (
      <code className="px-1.5 py-0.5 rounded text-[0.875em] font-mono bg-black/5 dark:bg-white/10 border border-black/5 dark:border-white/10">
        {children}
      </code>
    );
  }
  const lang = /language-(\w+)/.exec(className ?? '')?.[1] ?? 'text';
  // SyntaxHighlighter's typing wants `style` to be a specific object shape;
  // its prebuilt themes are typed loosely so we cast to any to avoid
  // dragging in @types/react-syntax-highlighter style fragments.
  const theme = (isDark ? vscDarkPlus : oneLight) as { [k: string]: React.CSSProperties };
  return (
    <div className="my-4 rounded-lg overflow-hidden border border-black/10 dark:border-white/10">
      {lang !== 'text' && (
        <div className="px-3 py-1.5 text-[10px] font-mono uppercase tracking-wider text-gray-500 bg-black/[0.03] dark:bg-white/[0.04] border-b border-black/10 dark:border-white/10">
          {lang}
        </div>
      )}
      <SyntaxHighlighter
        language={lang}
        style={theme}
        PreTag="div"
        customStyle={{
          margin: 0,
          padding: '14px 16px',
          fontSize: '12.5px',
          lineHeight: 1.6,
          background: 'transparent',
        }}
        codeTagProps={{ style: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' } }}
      >
        {text}
      </SyntaxHighlighter>
    </div>
  );
};

interface DocLinkProps {
  href?: string;
  children?: React.ReactNode;
  onInternalDoc: (slug: string, anchor?: string) => void;
}

const DocLink: React.FC<DocLinkProps> = ({ href, children, onInternalDoc }) => {
  const target = resolveLink(href ?? '');
  const onClick = (e: React.MouseEvent) => {
    e.preventDefault();
    if (target.kind === 'doc') {
      onInternalDoc(target.slug, target.anchor);
    } else if (target.kind === 'anchor') {
      const el = document.getElementById(target.anchor);
      el?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } else if (target.kind === 'external') {
      openExternal(target.url);
    }
  };
  // Only show external icon when the URL is a real http(s) source link
  // — same-doc anchors and cross-doc links read better without one.
  const showExternalIcon = target.kind === 'external' && /^https?:\/\//.test(target.url);
  return (
    <a
      href={href}
      onClick={onClick}
      className="text-blue-600 dark:text-blue-400 hover:underline underline-offset-2 inline-flex items-baseline gap-0.5"
    >
      {children}
      {showExternalIcon && <ArrowUpRight size={11} className="self-center opacity-70" />}
    </a>
  );
};

const HEADING_BASE = 'scroll-mt-24 group relative';
const HEADING_CLS = {
  1: 'text-3xl font-bold mt-2 mb-6 tracking-tight',
  2: 'text-2xl font-semibold mt-10 mb-3 tracking-tight border-b border-black/10 dark:border-white/10 pb-2',
  3: 'text-lg font-semibold mt-7 mb-2',
  4: 'text-base font-semibold mt-5 mb-1.5',
} as const;

interface HeadingProps {
  children?: React.ReactNode;
}

const HashAnchor: React.FC<{ id: string; size: number }> = ({ id, size }) => (
  <a
    href={`#${id}`}
    aria-label="Anchor"
    className="absolute -left-6 top-1/2 -translate-y-1/2 opacity-0 group-hover:opacity-60 hover:opacity-100 transition-opacity"
    onClick={(e) => {
      e.preventDefault();
      document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }}
  >
    <Hash size={size} />
  </a>
);

const H1: React.FC<HeadingProps> = ({ children }) => {
  const id = slugify(nodeText(children));
  return (
    <h1 id={id} className={`${HEADING_BASE} ${HEADING_CLS[1]}`}>
      <HashAnchor id={id} size={16} />
      {children}
    </h1>
  );
};

const H2: React.FC<HeadingProps> = ({ children }) => {
  const id = slugify(nodeText(children));
  return (
    <h2 id={id} className={`${HEADING_BASE} ${HEADING_CLS[2]}`}>
      <HashAnchor id={id} size={13} />
      {children}
    </h2>
  );
};

const H3: React.FC<HeadingProps> = ({ children }) => {
  const id = slugify(nodeText(children));
  return (
    <h3 id={id} className={`${HEADING_BASE} ${HEADING_CLS[3]}`}>
      <HashAnchor id={id} size={13} />
      {children}
    </h3>
  );
};

const H4: React.FC<HeadingProps> = ({ children }) => {
  const id = slugify(nodeText(children));
  return (
    <h4 id={id} className={`${HEADING_BASE} ${HEADING_CLS[4]}`}>
      <HashAnchor id={id} size={13} />
      {children}
    </h4>
  );
};

// ──────────────────────────────────────────────────────────────────
// SIDEBAR
// ──────────────────────────────────────────────────────────────────

interface SidebarProps {
  activeSlug: string;
  onSelect: (slug: string) => void;
  collapsed: boolean;
  onCollapsedChange: (v: boolean) => void;
  /** Combined registry — public docs always, plus admin docs when
   *  the caller is authenticated as admin. */
  docs: DocEntry[];
}

const Sidebar: React.FC<SidebarProps> = ({ activeSlug, onSelect, collapsed, onCollapsedChange, docs }) => {
  const grouped = useMemo(() => {
    const map = new Map<DocCategory, DocEntry[]>();
    for (const cat of CATEGORY_ORDER) map.set(cat, []);
    for (const d of docs) map.get(d.category)?.push(d);
    return map;
  }, [docs]);

  return (
    <aside
      className={`flex-shrink-0 border-r border-black/10 dark:border-white/10 bg-black/[0.015] dark:bg-white/[0.02] transition-all duration-200 ${
        collapsed ? 'w-0 overflow-hidden' : 'w-[260px]'
      } md:w-[260px]`}
      aria-label="Documentation navigation"
    >
      <nav className="h-full overflow-y-auto px-3 py-4">
        {CATEGORY_ORDER.map((cat) => {
          const docs = grouped.get(cat) ?? [];
          if (docs.length === 0) return null;
          return (
            <div key={cat} className="mb-5">
              <div className="px-2 mb-1.5 text-[10px] font-semibold tracking-[0.12em] uppercase text-gray-500 dark:text-gray-400">
                {cat}
              </div>
              <ul className="space-y-0.5">
                {docs.map((d) => {
                  const isActive = d.slug === activeSlug;
                  return (
                    <li key={d.slug}>
                      <button
                        type="button"
                        onClick={() => {
                          onSelect(d.slug);
                          onCollapsedChange(true);
                        }}
                        className={`w-full text-left flex items-center gap-2.5 px-2 py-1.5 rounded-md transition-colors text-[13px] ${
                          isActive
                            ? 'bg-blue-500/10 text-blue-600 dark:text-blue-400 font-medium'
                            : 'text-gray-700 dark:text-gray-300 hover:bg-black/[0.04] dark:hover:bg-white/[0.04]'
                        }`}
                        aria-current={isActive ? 'page' : undefined}
                      >
                        <span className={`flex-shrink-0 ${isActive ? 'text-blue-600 dark:text-blue-400' : 'text-gray-400'}`}>
                          {d.icon}
                        </span>
                        <span className="truncate">{d.title}</span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>
          );
        })}

        {/* Footer — contribute / report */}
        <div className="mt-6 pt-4 border-t border-black/10 dark:border-white/10 px-2">
          <button
            type="button"
            onClick={() => openExternal(`${GITHUB_REPO}/issues/new`)}
            className="w-full flex items-center gap-2 text-[12px] text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 transition-colors py-1"
          >
            <Github size={13} />
            <span>Report a doc issue</span>
            <ArrowUpRight size={11} className="ml-auto opacity-60" />
          </button>
        </div>
      </nav>
    </aside>
  );
};

// ──────────────────────────────────────────────────────────────────
// TOC RAIL (right-side, lg+)
// ──────────────────────────────────────────────────────────────────

interface TocRailProps {
  toc: TocEntry[];
  activeAnchor: string | null;
  onJump: (anchor: string) => void;
  doc: DocEntry;
}

const TocRail: React.FC<TocRailProps> = ({ toc, activeAnchor, onJump, doc }) => {
  if (toc.length === 0) return <aside className="hidden lg:block w-[220px]" />;
  return (
    <aside className="hidden lg:block w-[220px] flex-shrink-0 border-l border-black/10 dark:border-white/10 bg-black/[0.01] dark:bg-white/[0.015]">
      <div className="sticky top-0 px-4 py-5 max-h-screen overflow-y-auto">
        <div className="text-[10px] font-semibold tracking-[0.12em] uppercase text-gray-500 dark:text-gray-400 mb-2">
          On this page
        </div>
        <ul className="space-y-0.5">
          {toc.map((t) => {
            const isActive = t.anchor === activeAnchor;
            return (
              <li key={t.anchor}>
                <button
                  type="button"
                  onClick={() => onJump(t.anchor)}
                  className={`block w-full text-left text-[12px] py-1 px-2 rounded-md leading-snug transition-colors ${
                    isActive
                      ? 'text-blue-600 dark:text-blue-400 bg-blue-500/[0.08] font-medium'
                      : 'text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-100'
                  }`}
                >
                  {t.number && <span className="text-gray-400 mr-1.5">{t.number}.</span>}
                  {t.title}
                </button>
              </li>
            );
          })}
        </ul>
      </div>
    </aside>
  );
};

// ──────────────────────────────────────────────────────────────────
// SEARCH PALETTE (⌘K)
// ──────────────────────────────────────────────────────────────────

interface SearchPaletteProps {
  open: boolean;
  onClose: () => void;
  onSelect: (slug: string, anchor: string) => void;
}

const SearchPalette: React.FC<SearchPaletteProps> = ({ open, onClose, onSelect }) => {
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  const results = useMemo(() => {
    if (!query.trim()) return SEARCH_INDEX.slice(0, 50);
    const q = query.toLowerCase();
    return SEARCH_INDEX
      .filter((s) => s.toc.title.toLowerCase().includes(q) || s.docTitle.toLowerCase().includes(q))
      .slice(0, 50);
  }, [query]);

  useEffect(() => {
    if (!open) {
      setQuery('');
      setActiveIndex(0);
      return;
    }
    // Focus the input on open. RAF so the portal's mount has committed.
    requestAnimationFrame(() => inputRef.current?.focus());
  }, [open]);

  useEffect(() => {
    setActiveIndex(0);
  }, [query]);

  // Keep active item visible as user navigates with arrows.
  useEffect(() => {
    const el = listRef.current?.children[activeIndex] as HTMLElement | undefined;
    el?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex]);

  if (!open) return null;

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveIndex((i) => Math.min(results.length - 1, i + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIndex((i) => Math.max(0, i - 1));
    } else if (e.key === 'Enter' && results[activeIndex]) {
      e.preventDefault();
      const r = results[activeIndex];
      onSelect(r.docSlug, r.toc.anchor);
      onClose();
    }
  };

  return (
    <div
      className="fixed inset-0 z-[210] flex items-start justify-center pt-[12vh] px-4 bg-black/60 backdrop-blur-sm"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="Search documentation"
    >
      <div
        className="w-full max-w-xl bg-white dark:bg-zinc-900 rounded-xl shadow-2xl border border-black/10 dark:border-white/10 overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-3 px-4 py-3 border-b border-black/10 dark:border-white/10">
          <Search size={16} className="text-gray-400 flex-shrink-0" />
          <input
            ref={inputRef}
            type="text"
            placeholder="Search sections…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            className="flex-1 bg-transparent outline-none text-sm placeholder:text-gray-400 text-gray-900 dark:text-gray-100"
          />
          <kbd className="text-[10px] px-1.5 py-0.5 rounded font-mono bg-black/5 dark:bg-white/10 text-gray-500 dark:text-gray-400">
            Esc
          </kbd>
        </div>
        <ul ref={listRef} className="max-h-[50vh] overflow-y-auto py-1">
          {results.length === 0 && (
            <li className="px-4 py-6 text-center text-sm text-gray-400">
              No matches.
            </li>
          )}
          {results.map((r, i) => {
            const isActive = i === activeIndex;
            return (
              <li
                key={`${r.docSlug}-${r.toc.anchor}`}
                onMouseEnter={() => setActiveIndex(i)}
                onClick={() => {
                  onSelect(r.docSlug, r.toc.anchor);
                  onClose();
                }}
                className={`px-4 py-2 cursor-pointer flex items-center gap-3 transition-colors ${
                  isActive ? 'bg-blue-500/10' : ''
                }`}
              >
                <Hash size={13} className="text-gray-400 flex-shrink-0" />
                <div className="min-w-0 flex-1">
                  <div className="text-[13px] text-gray-900 dark:text-gray-100 truncate">
                    {r.toc.number && <span className="text-gray-400 mr-1.5">{r.toc.number}.</span>}
                    {r.toc.title}
                  </div>
                  <div className="text-[11px] text-gray-500 dark:text-gray-400 truncate">
                    {r.docTitle}
                  </div>
                </div>
                <ChevronRight size={14} className="text-gray-300 dark:text-gray-600" />
              </li>
            );
          })}
        </ul>
        <div className="px-4 py-2 border-t border-black/10 dark:border-white/10 text-[10px] text-gray-400 flex items-center gap-3">
          <span>
            <kbd className="mr-1 px-1 py-px rounded bg-black/5 dark:bg-white/10">↑↓</kbd>
            navigate
          </span>
          <span>
            <kbd className="mr-1 px-1 py-px rounded bg-black/5 dark:bg-white/10">↵</kbd>
            jump
          </span>
        </div>
      </div>
    </div>
  );
};

// ──────────────────────────────────────────────────────────────────
// MAIN COMPONENT
// ──────────────────────────────────────────────────────────────────

interface DocumentationProps {
  open: boolean;
  onClose: () => void;
  appVersion: string;
  isDark: boolean;
  /** JWT for the current session. If provided, the component probes
   *  /api/v1/support/admin-docs on mount — a 200 response unlocks the
   *  "Internal" doc category (visible only to admins). Anyone else gets
   *  401/403 from that endpoint and the section never appears. */
  authToken?: string | null;
  /** Override for the API base. Defaults to https://api.minicaai.com
   *  in prod, VITE_SERVER_URL in dev. */
  apiBase?: string;
}

const ADMIN_DOCS_API_BASE = (() => {
  if (typeof import.meta === 'undefined') return 'https://api.minicaai.com';
  const env = (import.meta as any).env || {};
  if (env.PROD) return 'https://api.minicaai.com';
  return env.VITE_SERVER_URL || 'https://api.minicaai.com';
})();

const Documentation: React.FC<DocumentationProps> = ({ open, onClose, appVersion, isDark, authToken, apiBase }) => {
  // Initial slug: pull from URL so deep-links like /docs/security and
  // bookmarks land on the right doc. Falls back to the first registry
  // entry ('getting-started') for the bare /docs path. We only consult
  // window.location once on mount — subsequent slug changes are pushed
  // back via the URL-sync effect.
  const defaultSlug = DOC_REGISTRY[0].slug;
  const [activeSlug, setActiveSlug] = useState<string>(() => {
    if (typeof window === 'undefined') return defaultSlug;
    const m = /^\/docs\/([\w-]+)\/?$/.exec(window.location.pathname);
    if (m && DOC_REGISTRY.some((d) => d.slug === m[1])) return m[1];
    // Note: admin doc slugs (admin-architecture etc.) are claimed by
    // /^\/docs\/([\w-]+)\/?$/ too — we just can't verify against the
    // admin registry until it loads. The fetch effect below will accept
    // the slug retroactively once admin docs land; until then we sit on
    // the default.
    if (m) return m[1];
    return defaultSlug;
  });
  const [searchOpen, setSearchOpen] = useState(false);
  const [activeAnchor, setActiveAnchor] = useState<string | null>(null);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const contentRef = useRef<HTMLDivElement>(null);

  // ── Admin docs (loaded on demand) ─────────────────────────────
  // If the caller passed an authToken AND the server says this user is
  // admin (i.e., /admin-docs returns 200), we add an Internal category
  // populated with the decrypted engineering docs. Anyone else just
  // sees the public DOC_REGISTRY.
  const [adminDocs, setAdminDocs] = useState<DocEntry[]>([]);
  useEffect(() => {
    if (!open || !authToken) return;
    let cancelled = false;
    const base = apiBase || ADMIN_DOCS_API_BASE;
    fetch(`${base}/api/v1/support/admin-docs`, {
      headers: { Authorization: `Bearer ${authToken}` },
    })
      .then(async (r) => {
        if (!r.ok) return null;
        return r.json();
      })
      .then((data) => {
        if (cancelled || !data || !Array.isArray(data.docs)) return;
        const entries: DocEntry[] = data.docs.map((d: { name: string; content: string }) => ({
          slug: adminDocSlugFor(d.name),
          title: prettyAdminTitle(d.name),
          summary: 'Internal — admin only.',
          category: 'Internal' as DocCategory,
          icon: <Lock {...ICON_PROPS} />,
          raw: d.content,
          sourcePath: `docs/private/${d.name}`,
          isInternal: true,
        }));
        setAdminDocs(entries);
      })
      .catch(() => { /* not admin, or fetch failed — silently skip */ });
    return () => { cancelled = true; };
  }, [open, authToken, apiBase]);

  // Combined registry: public docs + admin docs (when present).
  const allDocs = useMemo<DocEntry[]>(
    () => [...DOC_REGISTRY, ...adminDocs],
    [adminDocs],
  );

  // TOCs for admin docs (computed at render — public TOCs are still
  // in the module-level DOC_TOCS).
  const adminDocTocs = useMemo<Record<string, TocEntry[]>>(
    () => Object.fromEntries(adminDocs.map((d) => [d.slug, extractToc(d.raw)])),
    [adminDocs],
  );

  // Slug → URL via replaceState so doc-to-doc clicks don't accumulate
  // history entries (parent's /docs ↔ / transitions use pushState; here
  // we want refinements to be back-button-equivalent to the /docs entry).
  useEffect(() => {
    if (!open || typeof window === 'undefined') return;
    const target = activeSlug === defaultSlug ? '/docs' : `/docs/${activeSlug}`;
    if (window.location.pathname !== target) {
      window.history.replaceState(null, '', target);
    }
  }, [activeSlug, open, defaultSlug]);

  // Browser back/forward inside /docs paths (e.g. /docs/security →
  // /docs/privacy via the parent's history). Re-read the URL and update
  // active slug. The parent handles /docs ↔ / transitions; we only
  // claim slug-level changes that keep us inside /docs.
  useEffect(() => {
    if (!open) return;
    const onPop = () => {
      const m = /^\/docs\/([\w-]+)\/?$/.exec(window.location.pathname);
      if (m && allDocs.some((d) => d.slug === m[1])) {
        setActiveSlug(m[1]);
      } else if (window.location.pathname === '/docs') {
        setActiveSlug(defaultSlug);
      }
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, [open, defaultSlug]);

  // First-paint deep-link anchor: if the URL was /docs/<slug>#<anchor>
  // when the component mounted, scroll to that anchor after the markdown
  // commits. Only runs once per mount; subsequent in-app clicks handle
  // their own scroll via handleInternalDoc / onJumpToc.
  useEffect(() => {
    if (!open || typeof window === 'undefined') return;
    const hash = window.location.hash.replace(/^#/, '');
    if (!hash) return;
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        document.getElementById(hash)?.scrollIntoView({ behavior: 'auto', block: 'start' });
      });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const activeDoc = useMemo(
    () => allDocs.find((d) => d.slug === activeSlug) ?? DOC_REGISTRY[0],
    [activeSlug, allDocs],
  );
  const activeToc = DOC_TOCS[activeDoc.slug] ?? adminDocTocs[activeDoc.slug] ?? [];

  // Reset scroll on doc change. RAF so scrollTo lands after the new
  // markdown has committed (otherwise we scroll the stale tree).
  useEffect(() => {
    if (!open) return;
    requestAnimationFrame(() => {
      contentRef.current?.scrollTo({ top: 0, behavior: 'auto' });
    });
    setActiveAnchor(activeToc[0]?.anchor ?? null);
  }, [activeSlug, open, activeToc]);

  // Scrollspy: track which h2 is in the viewport. We observe the
  // headings inside the scroll container and pick the one closest to
  // the top edge of the visible region. Re-arm whenever active doc
  // changes (different headings to observe).
  useEffect(() => {
    if (!open) return;
    const root = contentRef.current;
    if (!root) return;
    let raf = 0;
    raf = requestAnimationFrame(() => {
      const headings = Array.from(root.querySelectorAll('h2[id]')) as HTMLElement[];
      if (headings.length === 0) return;
      const visibility = new Map<string, number>();
      const observer = new IntersectionObserver(
        (entries) => {
          for (const e of entries) {
            const id = (e.target as HTMLElement).id;
            visibility.set(id, e.intersectionRatio);
          }
          // Pick the heading with the largest visible ratio; tiebreak
          // by document order (first wins). Falls back to the heading
          // whose top edge is just above the scroll viewport when no
          // heading is currently intersecting (long sections).
          let best: { id: string; ratio: number } | null = null;
          for (const h of headings) {
            const r = visibility.get(h.id) ?? 0;
            if (r > 0 && (!best || r > best.ratio)) best = { id: h.id, ratio: r };
          }
          if (best) {
            setActiveAnchor(best.id);
          } else {
            // Nothing intersecting — pick the heading whose top is the
            // largest negative offset (i.e. just scrolled past).
            const scrollTop = root.scrollTop + 100;
            let last = headings[0];
            for (const h of headings) {
              if (h.offsetTop <= scrollTop) last = h;
            }
            setActiveAnchor(last.id);
          }
        },
        { root, rootMargin: '-80px 0px -65% 0px', threshold: [0, 0.25, 0.5, 1] },
      );
      headings.forEach((h) => observer.observe(h));
      // Store on a ref so cleanup gets the same observer instance.
      cleanupRef.current = () => observer.disconnect();
    });
    const cleanupRef = { current: () => cancelAnimationFrame(raf) };
    return () => cleanupRef.current();
  }, [activeSlug, open]);

  // Keyboard shortcuts. Esc cascades: close search first, then docs.
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (searchOpen) {
          setSearchOpen(false);
        } else {
          onClose();
        }
        return;
      }
      // Cmd+K / Ctrl+K to open search. Don't re-trigger if already open.
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setSearchOpen(true);
      }
      // "/" to open search when no input is focused
      if (e.key === '/' && !searchOpen) {
        const target = e.target as HTMLElement | null;
        if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
        if (target?.isContentEditable) return;
        e.preventDefault();
        setSearchOpen(true);
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [open, searchOpen, onClose]);

  // Internal nav from any link in the tree. If anchor present, scroll
  // after a microtask so the new doc's DOM has committed. We wait two
  // RAFs — the first lets React commit, the second lets the browser
  // lay out the new heights so scrollIntoView lands accurately.
  const handleInternalDoc = useCallback((slug: string, anchor?: string) => {
    setActiveSlug(slug);
    if (anchor) {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          const el = document.getElementById(anchor);
          el?.scrollIntoView({ behavior: 'smooth', block: 'start' });
        });
      });
    }
  }, []);

  const onJumpToc = useCallback((anchor: string) => {
    const el = document.getElementById(anchor);
    el?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    setActiveAnchor(anchor);
  }, []);

  // Markdown components (memoized so ReactMarkdown doesn't re-mount the tree on every render).
  const mdComponents = useMemo(
    () => ({
      h1: H1,
      h2: H2,
      h3: H3,
      h4: H4,
      a: ({ href, children }: { href?: string; children?: React.ReactNode }) => (
        <DocLink href={href} onInternalDoc={handleInternalDoc}>
          {children}
        </DocLink>
      ),
      code: (props: { className?: string; children?: React.ReactNode; inline?: boolean }) => (
        <CodeBlock {...props} isDark={isDark} />
      ),
      table: ({ children }: { children?: React.ReactNode }) => (
        <div className="my-5 overflow-x-auto rounded-lg border border-black/10 dark:border-white/10">
          <table className="w-full text-sm border-collapse">{children}</table>
        </div>
      ),
      thead: ({ children }: { children?: React.ReactNode }) => (
        <thead className="bg-black/[0.03] dark:bg-white/[0.04]">{children}</thead>
      ),
      th: ({ children }: { children?: React.ReactNode }) => (
        <th className="text-left font-semibold px-3 py-2 border-b border-black/10 dark:border-white/10">{children}</th>
      ),
      td: ({ children }: { children?: React.ReactNode }) => (
        <td className="px-3 py-2 border-b border-black/5 dark:border-white/5 align-top">{children}</td>
      ),
      blockquote: ({ children }: { children?: React.ReactNode }) => (
        <blockquote className="my-4 pl-4 border-l-4 border-blue-500/40 text-gray-700 dark:text-gray-300 italic">
          {children}
        </blockquote>
      ),
      hr: () => <hr className="my-8 border-black/10 dark:border-white/10" />,
      ul: ({ children }: { children?: React.ReactNode }) => (
        <ul className="my-3 ml-5 list-disc space-y-1">{children}</ul>
      ),
      ol: ({ children }: { children?: React.ReactNode }) => (
        <ol className="my-3 ml-5 list-decimal space-y-1">{children}</ol>
      ),
      li: ({ children }: { children?: React.ReactNode }) => <li className="leading-relaxed">{children}</li>,
      p: ({ children }: { children?: React.ReactNode }) => <p className="my-3 leading-relaxed">{children}</p>,
    }),
    [handleInternalDoc, isDark],
  );

  if (!open) return null;

  // Lock body scroll while the overlay is open. The overlay manages its own
  // scroll containers, and double-scrolling (overlay + body) is jarring.
  // We restore overflow on close.
  return createPortal(
    <DocumentationLayer
      activeDoc={activeDoc}
      activeToc={activeToc}
      activeAnchor={activeAnchor}
      isDark={isDark}
      appVersion={appVersion}
      onClose={onClose}
      onSelectSlug={setActiveSlug}
      onSearchOpen={() => setSearchOpen(true)}
      onJumpToc={onJumpToc}
      sidebarCollapsed={sidebarCollapsed}
      setSidebarCollapsed={setSidebarCollapsed}
      contentRef={contentRef}
      mdComponents={mdComponents}
      searchOpen={searchOpen}
      onSearchClose={() => setSearchOpen(false)}
      onSearchSelect={handleInternalDoc}
      docs={allDocs}
    />,
    document.body,
  );
};

// Split the layout into its own component so the body-lock effect can
// run mounted-only (the parent might be rendered with open=false on
// older state and we want clean mount/unmount semantics for cleanup).
interface LayerProps {
  activeDoc: DocEntry;
  activeToc: TocEntry[];
  activeAnchor: string | null;
  isDark: boolean;
  appVersion: string;
  onClose: () => void;
  onSelectSlug: (slug: string) => void;
  onSearchOpen: () => void;
  onJumpToc: (anchor: string) => void;
  sidebarCollapsed: boolean;
  setSidebarCollapsed: (v: boolean) => void;
  contentRef: React.RefObject<HTMLDivElement>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  mdComponents: any;
  searchOpen: boolean;
  onSearchClose: () => void;
  onSearchSelect: (slug: string, anchor?: string) => void;
  /** Sidebar's doc list — public + admin (when admin authenticated). */
  docs: DocEntry[];
}

const DocumentationLayer: React.FC<LayerProps> = ({
  activeDoc,
  activeToc,
  activeAnchor,
  isDark,
  appVersion,
  onClose,
  onSelectSlug,
  onSearchOpen,
  onJumpToc,
  sidebarCollapsed,
  setSidebarCollapsed,
  contentRef,
  mdComponents,
  searchOpen,
  onSearchClose,
  onSearchSelect,
  docs,
}) => {
  // Body scroll lock for the duration of the overlay.
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);

  return (
    <div className="fixed inset-0 z-[200] bg-white dark:bg-zinc-950 text-gray-900 dark:text-gray-100 flex flex-col" role="dialog" aria-modal="true" aria-label="Documentation">
      {/* HEADER */}
      <header className="flex-shrink-0 h-14 px-4 flex items-center gap-3 border-b border-black/10 dark:border-white/10 bg-white/80 dark:bg-zinc-950/80 backdrop-blur-sm">
        <button
          type="button"
          onClick={() => setSidebarCollapsed(!sidebarCollapsed)}
          className="md:hidden p-1.5 -ml-1 rounded-md hover:bg-black/5 dark:hover:bg-white/10"
          aria-label="Toggle navigation"
        >
          <Menu size={18} />
        </button>
        <div className="flex items-center gap-2">
          <Book size={18} className="text-blue-500" />
          <span className="font-semibold tracking-tight">Documentation</span>
          <span className="hidden sm:inline-block text-[11px] px-2 py-0.5 rounded-full bg-black/5 dark:bg-white/10 text-gray-500 dark:text-gray-400 font-mono">
            v{appVersion}
          </span>
        </div>
        <div className="flex-1" />
        <button
          type="button"
          onClick={onSearchOpen}
          className="hidden sm:flex items-center gap-2 px-3 py-1.5 rounded-md border border-black/10 dark:border-white/10 text-gray-500 dark:text-gray-400 text-sm hover:bg-black/5 dark:hover:bg-white/[0.06] transition-colors w-[260px]"
          aria-label="Search documentation"
        >
          <Search size={14} />
          <span className="flex-1 text-left">Search…</span>
          <kbd className="text-[10px] px-1.5 py-0.5 rounded font-mono bg-black/5 dark:bg-white/10">⌘K</kbd>
        </button>
        <button
          type="button"
          onClick={onSearchOpen}
          className="sm:hidden p-1.5 rounded-md hover:bg-black/5 dark:hover:bg-white/10"
          aria-label="Search documentation"
        >
          <Search size={18} />
        </button>
        <button
          type="button"
          onClick={onClose}
          className="p-1.5 rounded-md hover:bg-black/5 dark:hover:bg-white/10"
          aria-label="Close documentation"
        >
          <X size={18} />
        </button>
      </header>

      {/* BODY */}
      <div className="flex-1 flex min-h-0 overflow-hidden">
        <Sidebar
          activeSlug={activeDoc.slug}
          onSelect={onSelectSlug}
          collapsed={sidebarCollapsed}
          onCollapsedChange={setSidebarCollapsed}
          docs={docs}
        />

        <main
          ref={contentRef}
          className="flex-1 min-w-0 overflow-y-auto px-5 sm:px-8 lg:px-10 py-6 sm:py-8"
        >
          <div className="mx-auto max-w-[820px]">
            {/* Breadcrumb */}
            <nav className="text-[12px] text-gray-500 dark:text-gray-400 mb-4 flex items-center gap-1.5" aria-label="Breadcrumb">
              <span>Documentation</span>
              <ChevronRight size={12} className="opacity-60" />
              <span className="text-gray-700 dark:text-gray-300">{activeDoc.category}</span>
              <ChevronRight size={12} className="opacity-60" />
              <span className="text-gray-900 dark:text-gray-100 font-medium">{activeDoc.title}</span>
            </nav>

            {/* Doc summary card — shown above the rendered content as a quick orient */}
            <div className="mb-6 px-4 py-3 rounded-lg bg-gradient-to-br from-blue-500/[0.08] to-purple-500/[0.04] border border-blue-500/15 flex items-start gap-3">
              <span className="flex-shrink-0 w-8 h-8 rounded-md bg-blue-500/15 flex items-center justify-center text-blue-600 dark:text-blue-400">
                {activeDoc.icon}
              </span>
              <div className="min-w-0 flex-1">
                <div className="font-semibold text-[14px]">{activeDoc.title}</div>
                <div className="text-[12.5px] text-gray-600 dark:text-gray-400 leading-relaxed">{activeDoc.summary}</div>
              </div>
            </div>

            {/* Rendered markdown */}
            <article className="doc-content text-[14px] sm:text-[14.5px] leading-relaxed text-gray-800 dark:text-gray-200">
              <ReactMarkdown remarkPlugins={[remarkGfm]} components={mdComponents}>
                {activeDoc.raw}
              </ReactMarkdown>
            </article>

            {/* Footer — feedback CTA */}
            <footer className="mt-12 pt-6 border-t border-black/10 dark:border-white/10 flex flex-col sm:flex-row sm:items-center justify-between gap-3 text-[12px] text-gray-500 dark:text-gray-400">
              <div>
                Documentation for <span className="font-mono">v{appVersion}</span>. Updated with every release.
              </div>
              <div className="flex items-center gap-3">
                <button
                  type="button"
                  onClick={() => openExternal(`${GITHUB_REPO}/issues/new?title=Doc%20feedback%3A%20${encodeURIComponent(activeDoc.title)}`)}
                  className="inline-flex items-center gap-1.5 hover:text-gray-800 dark:hover:text-gray-200 transition-colors"
                >
                  <span>Was this helpful?</span>
                </button>
              </div>
            </footer>
          </div>
        </main>

        <TocRail toc={activeToc} activeAnchor={activeAnchor} onJump={onJumpToc} doc={activeDoc} />
      </div>

      <SearchPalette open={searchOpen} onClose={onSearchClose} onSelect={onSearchSelect} />
    </div>
  );
};

export default Documentation;

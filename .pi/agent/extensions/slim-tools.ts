// slim-tools.ts — one-line rendering for every tool call in pi's transcript.
//
// Every tool call and result renders as a single line:
//
//   ✓ $ git status -sb · ## main...origin/main        0.3s
//   ✗ $ npm test · Command exited with code 1         2.1s
//   ✓ ≡ src/foo.ts · 120 lines
//   ✓ ± src/foo.ts +3 −2
//   ✓ ⌕ TODO · 14 lines
//   ✓ 🔗 example.com/page.html +1 · page summary      0.9s
//   ✓ ⌥ c1internal/find_api_objects · {"type":"App",…}
//
// Status icon: ✓ success / ✗ failure (red) / ◆ running (ticking clock). The
// identity of each call (command's first word, path, pattern, server/tool) is
// accent-bold; everything else stays dim. Long lines truncate their body — the
// elapsed/timeout suffix is always pinned to the terminal edge.
//
// Consecutive tool calls stack flush; a blank line separates tool groups from
// prose/thinking/user messages.
//
// Ctrl+O (pi's built-in app.tools.expand) expands any row to full detail.
//
// Commands: /slim-tools-off, /slim-tools-on, /slim-diag.
// Requires a Nerd Font for the glyphs; all icons are from the FA4-stable range.
import * as os from "node:os";
import {
	createBashToolDefinition,
	createEditToolDefinition,
	createFindToolDefinition,
	createGrepToolDefinition,
	createLsToolDefinition,
	createPowerShellToolDefinition,
	createReadToolDefinition,
	createWriteToolDefinition,
	type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

type Theme = { fg: (name: string, text: string) => string; bold?: (text: string) => string };
type Args = any;
type ToolResult = { content: Array<{ type: string; text?: string }>; details?: any };
type Ctx = { state: any; expanded?: boolean; isError?: boolean; executionStarted?: boolean };

// ---------------------------------------------------------------------------
// Icons — one glyph per tool. FontAwesome 4 codepoints (U+F000–F2E0) render in
// every Nerd Fonts build; newer sets (codicons etc.) may be missing from older
// font installations.
// ---------------------------------------------------------------------------

const TOOL_ICONS: Record<string, string> = {
	bash: "$", // shell prompt
	powershell: "$", // shell prompt
	read: "\uF02D", // fa-book
	edit: "\uF044", // fa-edit
	write: "\uF0F6", // fa-file-text-o
	grep: "\uF069", // fa-asterisk (regex star)
	find: "\uF002", // fa-search
	ls: "\uF07B", // fa-folder
	mcp: "\uF1E6", // fa-plug
	mcpScript: "\uF121", // fa-code
	web_search: "\uF0AC", // fa-globe
	url_context: "\uF0C1", // fa-link
};

const ICON_CHECK = "\uF00C"; // fa-check
const ICON_CROSS = "\uF00D"; // fa-times
const ICON_RUN = "\uF110"; // fa-spinner

function statusGlyph(failed: boolean, partial: boolean, theme: Theme): string {
	if (partial) return theme.fg("accent", ICON_RUN);
	return failed ? theme.fg("error", ICON_CROSS) : theme.fg("success", ICON_CHECK);
}

function toolGlyph(theme: Theme, toolName: string): string {
	return theme.fg("accent", TOOL_ICONS[toolName] ?? toolName);
}

// ---------------------------------------------------------------------------
// Diagnostics (surfaced by /slim-diag)
// ---------------------------------------------------------------------------

const VERSION = "1.0.0";

const slimDiag = {
	version: VERSION,
	patched: [] as string[],
	wrapperHits: 0,
	foreignWrapper: "" as string,
	gapLog: [] as Array<{ dropped: boolean; chain: string }>,
};

export const __slimDiag = slimDiag;

function logGap(dropped: boolean, chain: string[]): void {
	slimDiag.gapLog.push({ dropped, chain: chain.join("\u2192") || "first-child" });
	if (slimDiag.gapLog.length > 5) slimDiag.gapLog.shift();
}

// ---------------------------------------------------------------------------
// Minimal components. The result slot renders everything; lines are truncated
// to the terminal width so a row never visually wraps.
// ---------------------------------------------------------------------------

class Empty {
	render(): string[] {
		return [];
	}
	invalidate() {}
}

class SlimLine {
	text: string;
	suffix = ""; // right-stuck; never truncated — the body yields width for it
	private cached?: { w: number; lines: string[] };

	constructor(text = "") {
		this.text = text;
	}

	setText(t: string) {
		if (t !== this.text) {
			this.text = t;
			this.cached = undefined;
		}
	}

	setSuffix(s: string) {
		if (s !== this.suffix) {
			this.suffix = s;
			this.cached = undefined;
		}
	}

	invalidate() {
		this.cached = undefined;
	}

	render(width: number): string[] {
		const w = Math.max(1, Math.floor(width));
		if (!this.cached || this.cached.w !== w) {
			const suffixW = this.suffix ? visibleWidth(this.suffix) + 1 : 0;
			const body = suffixW ? truncateToWidth(this.text, Math.max(1, w - suffixW), "…") : truncateToWidth(this.text, w, "…");
			this.cached = { w, lines: [suffixW ? `${body} ${this.suffix}` : body] };
		}
		return this.cached.lines;
	}
}

class Block {
	constructor(
		private header: string,
		private lines: string[],
	) {}
	private cached?: { w: number; out: string[] };

	render(width: number): string[] {
		const w = Math.max(1, Math.floor(width));
		if (this.cached?.w === w) return this.cached.out;
		this.cached = {
			w,
			out: [truncateToWidth(this.header, w, "…"), ...this.lines.map((l) => truncateToWidth(l, w, "…"))],
		};
		return this.cached.out;
	}

	invalidate() {
		this.cached = undefined;
	}
}

// ---------------------------------------------------------------------------
// Text helpers
// ---------------------------------------------------------------------------

function shortenPath(p: string): string {
	if (typeof p !== "string" || p === "") return "";
	const home = os.homedir();
	return home && p.startsWith(home) ? `~${p.slice(home.length)}` : p;
}

function textOf(result: ToolResult): string {
	return (result?.content ?? [])
		.filter((c) => c.type === "text")
		.map((c) => c.text || "")
		.join("\n");
}

function contentLines(result: ToolResult): string[] {
	const t = textOf(result);
	if (!t) return [];
	return t.replace(/\r/g, "").replace(/\n$/, "").split("\n");
}

function firstLine(result: ToolResult): string {
	for (const l of contentLines(result)) {
		const s = l.trim();
		if (s) return s;
	}
	return "(no output)";
}

function lastLine(result: ToolResult): string {
	const lines = contentLines(result);
	for (let i = lines.length - 1; i >= 0; i--) {
		const s = lines[i].trim();
		if (s) return s;
	}
	return "(no output)";
}

function oneLine(s: string): string {
	return (s ?? "").replace(/\s*\n\s*/g, "; ").trim();
}

function countLines(result: ToolResult): number {
	return contentLines(result).length;
}

function truncSuffix(result: ToolResult): string {
	return result?.details?.truncation?.truncated ? " (truncated)" : "";
}

function diffStats(result: ToolResult): { added: number; removed: number } | undefined {
	const diff = result?.details?.diff;
	if (typeof diff !== "string") return undefined;
	let added = 0;
	let removed = 0;
	for (const raw of diff.split("\n")) {
		const line = raw.replace(/\s+$/, "");
		if (line.startsWith("+") && !line.startsWith("+++")) added++;
		else if (line.startsWith("-") && !line.startsWith("---")) removed++;
	}
	return { added, removed };
}

function colorizedDiff(diff: string, theme: Theme): string[] {
	return diff.split("\n").map((l) => {
		if (l.startsWith("+") && !l.startsWith("+++")) return theme.fg("success", l);
		if (l.startsWith("-") && !l.startsWith("---")) return theme.fg("error", l);
		if (l.startsWith("@@") || l.startsWith("index ") || l.startsWith("diff ")) return theme.fg("dim", l);
		return theme.fg("toolOutput", l);
	});
}

function formatDuration(ms: number): string {
	const s = ms / 1000;
	if (s < 60) return `${s.toFixed(1)}s`;
	const total = Math.floor(s);
	const m = Math.floor(total / 60);
	const r = total % 60;
	return m < 60 ? `${m}m ${r}s` : `${Math.floor(m / 60)}h ${m % 60}m ${r}s`;
}

// ---------------------------------------------------------------------------
// Slim renderers. The call slot stays empty; the result slot renders the whole
// line (running state first, final state after).
// ---------------------------------------------------------------------------

interface FinalLine {
	line: string;
	detail?: string[]; // extra lines shown when expanded
	suffix?: string; // right-stuck (duration/timeout) — never truncated
}

// The host passes its live Theme object into every renderer call; capture it so
// the render-level wrapper (which has no theme argument) can colorize MCP rows.
let capturedTheme: Theme | undefined;

function makeSlimRenderers(
	toolName: string,
	argSummary: (args: Args) => string,
	finalize: (result: ToolResult, args: Args, theme: Theme, ctx: Ctx, toolName: string) => FinalLine,
	partialSummary?: (args: Args, theme: Theme) => string,
) {
	return {
		renderCall(_args: Args, theme: Theme, context: Ctx) {
			// Track start time for the duration display; the call slot stays empty.
			if (context.executionStarted && context.state.startedAt === undefined) {
				context.state.startedAt = Date.now();
			}
			if (theme) capturedTheme = theme;
			return new Empty();
		},
		renderResult(result: ToolResult, options: { expanded: boolean; isPartial: boolean }, theme: Theme, context: Ctx) {
			const args = (context as any).args;
			if (theme) capturedTheme = theme;

			if (options.isPartial && !context.isError) {
				// Running: tick once a second via context.invalidate (the same pattern
				// pi's own bash renderer uses). Elapsed shows whole seconds, right-stuck.
				if (context.state.startedAt !== undefined && !context.state.interval) {
					context.state.interval = setInterval(() => {
						try {
							context.invalidate();
						} catch {}
					}, 1000);
				}
				const elapsed =
					context.state.startedAt !== undefined ? `${Math.floor((Date.now() - context.state.startedAt) / 1000)}s` : "";
				const to = args?.timeout ? `${args.timeout}s` : "";
				const suffix = elapsed ? `${elapsed}${to ? "/" + to : ""}` : "";
				const summary = partialSummary ? partialSummary(args, theme) : theme.fg("accent", argSummary(args));
				const line = new SlimLine(statusGlyph(false, true, theme) + " " + toolGlyph(theme, toolName) + " " + summary);
				line.setSuffix(suffix ? theme.fg("muted", suffix) : "");
				return line;
			}

			if (context.state.interval) {
				clearInterval(context.state.interval);
				context.state.interval = undefined;
			}
			context.state.endedAt ??= Date.now();

			const { line, detail, suffix: finalSuffix } = finalize(result, args, theme, context, toolName);
			const styledSuffix = finalSuffix ? theme.fg("muted", finalSuffix) : "";
			if (options.expanded) {
				// Expanded view names the tool explicitly (icons alone are cryptic there).
				const header = line + (finalSuffix ? theme.fg("dim", ` · ${finalSuffix}`) : "") + theme.fg("dim", ` · ${toolName}`);
				return new Block(header, detail ?? []);
			}
			const last = context.state.lastComponent as SlimLine | undefined;
			if (last instanceof SlimLine) {
				last.setText(line);
				last.setSuffix(styledSuffix);
				return last;
			}
			const comp = new SlimLine(line);
			comp.setSuffix(styledSuffix);
			context.state.lastComponent = comp;
			return comp;
		},
	};
}

// ---------------------------------------------------------------------------
// Per-tool summarizers
// ---------------------------------------------------------------------------

// Shell command styling shared by running + final rows: first word (the
// program) accent-bold, remainder dim.
function styleShellCmd(cmd: string, theme: Theme): string {
	const sp = cmd.indexOf(" ");
	const head = sp === -1 ? cmd : cmd.slice(0, sp);
	const rest = sp === -1 ? "" : " " + cmd.slice(sp + 1);
	return theme.bold(theme.fg("accent", head)) + (rest ? theme.fg("dim", rest) : "");
}

function contextIsError(ctx: Ctx): boolean {
	return ctx.isError === true;
}

function shellFinal(result: ToolResult, args: Args, theme: Theme, ctx: Ctx, _toolName: string): FinalLine {
	const cmd = oneLine(args?.command) || "(no command)";
	const startedAt = ctx.state.startedAt;
	const dur = startedAt !== undefined ? formatDuration((ctx.state.endedAt ?? Date.now()) - startedAt) : "";
	const timeout = args?.timeout ? `${args.timeout}s` : "";
	const suffix = [dur, timeout].filter(Boolean).join("/");
	const detail = contextIsError(ctx) ? lastLine(result) : firstLine(result);
	return {
		line: `${statusGlyph(contextIsError(ctx), false, theme)} ${toolGlyph(theme, "bash")} ${styleShellCmd(cmd, theme)} · ${theme.fg("dim", detail)}`,
		detail: [oneLine(args?.command) || "(no command)", "", ...contentLines(result).map((l) => theme.fg("toolOutput", l))],
		suffix,
	};
}

function readFinal(result: ToolResult, args: Args, theme: Theme, ctx: Ctx, toolName: string): FinalLine {
	const isImage = (result?.content ?? []).some((c) => c.type === "image");
	const loc = typeof args?.offset === "number" ? ` @${args.offset}${args.limit != null ? `+${args.limit}` : ""}` : "";
	const detail = isImage ? "image" : `${countLines(result)} lines${truncSuffix(result)}`;
	return {
		line: `${statusGlyph(contextIsError(ctx), false, theme)} ${toolGlyph(theme, toolName)} ${theme.fg("accent", shortenPath(String(args?.path ?? "")))}${theme.fg("muted", loc)} · ${theme.fg("dim", detail)}`,
		detail: contentLines(result).map((l) => theme.fg("toolOutput", l)),
	};
}

function editFinal(result: ToolResult, args: Args, theme: Theme, ctx: Ctx, toolName: string): FinalLine {
	const stats = diffStats(result);
	const edits = Array.isArray(args?.edits) ? args.edits.length : 0;
	const detail = stats
		? `${theme.fg("success", `+${stats.added}`)} ${theme.fg("error", `−${stats.removed}`)}`
		: theme.fg("dim", `${edits} edit${edits === 1 ? "" : "s"}`);
	return {
		line: `${statusGlyph(contextIsError(ctx), false, theme)} ${toolGlyph(theme, toolName)} ${theme.fg("accent", shortenPath(String(args?.path ?? "")))} ${detail}`,
		detail: typeof result?.details?.diff === "string" ? colorizedDiff(result.details.diff, theme) : [],
	};
}

function writeFinal(result: ToolResult, args: Args, theme: Theme, ctx: Ctx, toolName: string): FinalLine {
	const content = typeof args?.content === "string" ? args.content : "";
	const n = content ? content.replace(/\n$/, "").split("\n").length : 0;
	return {
		line: `${statusGlyph(contextIsError(ctx), false, theme)} ${toolGlyph(theme, toolName)} ${theme.fg("accent", shortenPath(String(args?.path ?? "")))} · ${theme.fg("dim", `${n} lines`)}`,
		detail: content ? content.replace(/\n$/, "").split("\n").map((l) => theme.fg("toolOutput", l)) : [],
	};
}

function grepFinal(result: ToolResult, args: Args, theme: Theme, ctx: Ctx, toolName: string): FinalLine {
	const n = countLines(result);
	const pat = oneLine(args?.pattern);
	const where = args?.path ? ` in ${shortenPath(String(args.path))}` : "";
	const lim = result?.details?.matchLimitReached ? " (limit)" : "";
	return {
		line: `${statusGlyph(contextIsError(ctx), false, theme)} ${toolGlyph(theme, toolName)} ${theme.bold(theme.fg("accent", pat))}${theme.fg("muted", where)} · ${theme.fg("dim", `${n} lines${lim}${truncSuffix(result)}`)}`,
		detail: contentLines(result).map((l) => theme.fg("toolOutput", l)),
	};
}

function findFinal(result: ToolResult, args: Args, theme: Theme, ctx: Ctx, toolName: string): FinalLine {
	const n = countLines(result);
	const lim = result?.details?.resultLimitReached ? " (limit)" : "";
	return {
		line: `${statusGlyph(contextIsError(ctx), false, theme)} ${toolGlyph(theme, toolName)} ${theme.fg("accent", oneLine(args?.pattern))} · ${theme.fg("dim", `${n} paths${lim}${truncSuffix(result)}`)}`,
		detail: contentLines(result).map((l) => theme.fg("toolOutput", l)),
	};
}

function lsFinal(result: ToolResult, args: Args, theme: Theme, ctx: Ctx, toolName: string): FinalLine {
	const n = countLines(result);
	const lim = result?.details?.entryLimitReached ? " (limit)" : "";
	return {
		line: `${statusGlyph(contextIsError(ctx), false, theme)} ${toolGlyph(theme, toolName)} ${theme.fg("accent", shortenPath(String(args?.path ?? ".")))} · ${theme.fg("dim", `${n} entries${truncSuffix(result)}`)}`,
		detail: contentLines(result).map((l) => theme.fg("toolOutput", l)),
	};
}

// ---------------------------------------------------------------------------
// Row classification for render-level restyling: MCP rows (the adapter's proxy
// and direct tools) plus the pi-web-search package tools. These tools can't be
// re-registered safely (their execute closures aren't reachable), so their rows
// are restyled at the component level instead.
// ---------------------------------------------------------------------------

const WEB_TOOLS = new Set(["web_search", "url_context"]);

function isSlimRow(comp: any): boolean {
	if (WEB_TOOLS.has(comp?.toolName)) return true;
	if (comp?.toolName === "mcp" || comp?.toolName === "mcpScript") return true;
	if (typeof comp?.toolDefinition?.label === "string" && comp.toolDefinition.label.startsWith("MCP")) return true;
	return comp?.result?.details?.mode === "call";
}

function shortenUrl(url: string): string {
	const stripped = (url ?? "").replace(/^https?:\/\//, "").replace(/\?.*$/, "").replace(/#.*$/, "");
	return stripped.length > 48 ? `${stripped.slice(0, 47)}…` : stripped;
}

// Running/took-time tracking per row instance.
const rowStart = new WeakMap<object, number>();
const rowTook = new WeakMap<object, number>();

function mcpOneLine(comp: any, width: number, elapsed = ""): string {
	const theme = capturedTheme ?? { fg: (_n: string, s: string) => s };
	const fg = (n: string, t: string) => theme.fg(n, t);
	const args = comp.args ?? {};
	const result = comp.result;
	const failed = result?.isError === true || !!result?.details?.error;
	const partial = comp.isPartial === true;
	const isScript = comp.toolName === "mcpScript";

	const st = statusGlyph(failed, partial, theme);
	const glyph = fg("accent", TOOL_ICONS[comp.toolName] ?? "\uF1E6");

	let label = "";
	if (comp.toolName === "mcp") {
		const d = result?.details;
		if (typeof d?.server === "string" && typeof d?.tool === "string") label = `${d.server}/${d.tool}`;
		else if (typeof args?.tool === "string") label = args.tool;
	} else if (comp.toolName === "web_search") {
		label = oneLine(String(args?.query ?? "")) || "…";
	} else if (comp.toolName === "url_context") {
		const urls: string[] = Array.isArray(args?.urls) ? args.urls.map(String) : [];
		label = urls.length ? `${shortenUrl(urls[0])}${urls.length > 1 ? ` +${urls.length - 1}` : ""}` : "…";
	} else if (comp.toolName !== "mcpScript") {
		// Adapter direct tool: the name IS the identity (e.g. c1internal_find_api_objects).
		label = String(comp.toolName ?? "");
	}

	let digest = "";
	if (partial) {
		if (isScript && typeof args?.code === "string") digest = `${args.code.length} chars`;
	} else if (result) {
		digest = failed ? lastLine(result) : firstLine(result);
		// MCP results are often one giant JSON line — cap before styling.
		if (digest.length > 120) digest = digest.slice(0, 119) + "…";
	}

	const head = label ? `${glyph} ${fg("accent", label)}` : glyph;
	const line = digest ? `${st} ${head} · ${fg("dim", digest)}` : `${st} ${head}`;
	// Right-stuck time: the body yields width; the time is never truncated.
	if (elapsed) {
		const timeStr = fg("muted", elapsed);
		const budget = Math.max(1, width - visibleWidth(timeStr) - 1);
		return `${truncateToWidth(line, budget, "…")} ${timeStr}`;
	}
	return truncateToWidth(line, Math.max(1, width), "…");
}

// ---------------------------------------------------------------------------
// Gap collapsing: consecutive tool calls stack flush; a blank line separates
// tool groups from prose/thinking/user messages. Implemented by wrapping the
// host ToolExecutionComponent's render: each row pushes one leading blank, and
// the wrapper drops it when the row is mid-group (walking backward through the
// chat container's children until a tool row or visible content is found).
// ---------------------------------------------------------------------------

function looksLikeToolRow(c: any): boolean {
	return (
		!!c &&
		typeof c.updateResult === "function" &&
		typeof c.updateArgs === "function" &&
		typeof c.setExpanded === "function"
	);
}

// AssistantMessageComponent for a tool-call-only turn: structurally inserted
// between consecutive tool rows by the host, but renders zero lines — part of
// the tool-call group.
function rendersInvisible(c: any): boolean {
	try {
		return (
			typeof c?.updateContent === "function" &&
			!!c?.contentContainer &&
			Array.isArray(c.contentContainer.children) &&
			c.contentContainer.children.length === 0
		);
	} catch {
		return false;
	}
}

function inToolGroup(comp: any): boolean {
	try {
		const siblings = comp?.__slimParent?.children;
		if (!Array.isArray(siblings)) {
			logGap(false, ["no-siblings"]);
			return false;
		}
		let idx = siblings.indexOf(comp);
		const chain: string[] = [];
		while (idx > 0) {
			const prev = siblings[idx - 1];
			if (looksLikeToolRow(prev)) {
				chain.push("toolRow");
				logGap(true, chain);
				return true; // reached a tool row → mid-group
			}
			if (rendersInvisible(prev)) {
				chain.push("invisibleAsst");
				idx--; // invisible assistant → part of the chain, keep walking
				continue;
			}
			chain.push(prev?.constructor?.name?.replace(/Component$/, "") || "other");
			logGap(false, chain);
			return false; // visible content (user msg, prose) → this row STARTS the group
		}
		logGap(false, chain);
		return false;
	} catch {
		return false;
	}
}

function makeRenderWrapper(origRender: any): (this: any, width: number) => string[] {
	return function SLIM_WRAPPER(this: any, width: number): string[] {
		slimDiag.wrapperHits++;
		const lines: string[] = origRender.call(this, width);
		try {
			const sameGroup = inToolGroup(this);

			// MCP/web rows: render our own one-liner when collapsed; pass the tool's
			// own detail through when expanded.
			if (slimEnabled && isSlimRow(this) && !this.expanded) {
				// Live elapsed for running rows: record start, tick via the row's own
				// ui.requestRender, freeze the took-time once a result lands.
				let elapsed = "";
				const done = !!this.result;
				if (!done) {
					if (!rowStart.has(this)) rowStart.set(this, Date.now());
					elapsed = `${Math.floor((Date.now() - rowStart.get(this)!) / 1000)}s`;
					if (!(this as any).__slimTick) {
						(this as any).__slimTick = setInterval(() => {
							try {
								(this as any).ui?.requestRender?.();
							} catch {}
						}, 1000);
					}
				} else {
					if ((this as any).__slimTick) {
						clearInterval((this as any).__slimTick);
						(this as any).__slimTick = undefined;
					}
					if (rowStart.has(this) && !rowTook.has(this)) rowTook.set(this, Date.now() - rowStart.get(this)!);
					if (rowTook.has(this)) elapsed = formatDuration(rowTook.get(this)!);
				}
				const line = mcpOneLine(this, width, elapsed);
				return sameGroup ? [line] : ["", line];
			}

			if (Array.isArray(lines) && lines[0] === "" && sameGroup) return lines.slice(1);
		} catch {}
		return lines;
	};
}

function patchToolExecProto(sourcePath: string, proto: any): void {
	if (!proto || typeof proto.render !== "function") return;

	// Generational check: /reload gives each load a fresh module, but the host
	// prototype persists. Wrappers carry the permanent SLIM_WRAPPER name; only a
	// wrapper we recognize is rewrapped (replacing the previous generation).
	const existing = String(proto.render);
	if (proto.__slimGap && !existing.includes("SLIM_WRAPPER")) {
		slimDiag.foreignWrapper = existing.slice(0, 200);
		return; // wrapped by foreign code — don't stack
	}
	if (existing.includes("SLIM_WRAPPER")) return; // this generation already installed
	proto.__slimGap = true;
	slimDiag.patched.push(sourcePath);

	// Stamp parent refs when the host adds components to any container, so a
	// tool row can find its previous sibling at render time. The proto chain is
	// ToolExec.prototype → Container.prototype.
	const containerProto = Object.getPrototypeOf(proto);
	if (containerProto?.addChild && !containerProto.__slimStamp) {
		containerProto.__slimStamp = true;
		const origAdd = containerProto.addChild;
		containerProto.addChild = function (this: any, child: any) {
			try {
				Object.defineProperty(child, "__slimParent", {
					value: this,
					configurable: true,
					writable: true,
					enumerable: false,
				});
			} catch {}
			return origAdd.call(this, child);
		};
	}

	proto.render = makeRenderWrapper(proto.render);
}

function patchToolExecClass(sourcePath: string, ToolExec: any): void {
	patchToolExecProto(sourcePath, ToolExec?.prototype);
}

function findToolExecExport(m: any, depth = 2): any {
	// Module records vary in shape across loader modes; scan (2 levels) for a
	// function whose prototype carries render + the tool-row method trio.
	if (depth < 0 || !m || (typeof m !== "object" && typeof m !== "function")) return undefined;
	const visited = new Set<any>();
	const visit = (obj: any, d: number): any => {
		if (!obj || (typeof obj !== "object" && typeof obj !== "function") || visited.has(obj)) return undefined;
		visited.add(obj);
		const proto = (obj as any).prototype;
		if (proto && typeof proto.render === "function" && looksLikeToolRow(proto)) return obj;
		if (d <= 0) return undefined;
		let keys: string[] = [];
		try {
			keys = Object.keys(obj);
		} catch {
			return undefined;
		}
		for (const k of keys) {
			try {
				const hit = visit((obj as any)[k], d - 1);
				if (hit) return hit;
			} catch {}
		}
		return undefined;
	};
	return visit(m, depth);
}

async function installGapCollapser(): Promise<void> {
	// ONE import path resolves correctly in every runtime mode: the package
	// specifier maps to the host's own module graph (virtual modules in the
	// bundled runtime, the aliased dist entry in dev mode).
	let m: any;
	try {
		m = await import("@earendil-works/pi-coding-agent");
	} catch {
		return; // binding failure = stock spacing, never a crash
	}
	const mod = m?.ToolExecutionComponent ? m : m?.default;
	const te = findToolExecExport(mod) ?? findToolExecExport(m);
	if (te) patchToolExecClass("package specifier", te);
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

let slimEnabled = true;

export default async function (pi: ExtensionAPI) {
	const cwd = process.cwd();

	try {
		await installGapCollapser();
	} catch {
		// binding failure = stock spacing, never a crash
	}

	const base: Record<string, any> = {
		bash: createBashToolDefinition(cwd),
		read: createReadToolDefinition(cwd),
		edit: createEditToolDefinition(cwd),
		write: createWriteToolDefinition(cwd),
		grep: createGrepToolDefinition(cwd),
		find: createFindToolDefinition(cwd),
		ls: createLsToolDefinition(cwd),
		powershell: createPowerShellToolDefinition(cwd),
	};
	const slimByTool: Record<string, ReturnType<typeof makeSlimRenderers>> = {
		bash: makeSlimRenderers("bash", (a) => oneLine(a?.command), shellFinal, (a, t) => styleShellCmd(oneLine(a?.command) || "(no command)", t)),
		powershell: makeSlimRenderers("powershell", (a) => oneLine(a?.command), shellFinal, (a, t) => styleShellCmd(oneLine(a?.command) || "(no command)", t)),
		read: makeSlimRenderers("read", (a) => shortenPath(String(a?.path ?? "")), readFinal),
		edit: makeSlimRenderers("edit", (a) => shortenPath(String(a?.path ?? "")), editFinal),
		write: makeSlimRenderers("write", (a) => shortenPath(String(a?.path ?? "")), writeFinal),
		grep: makeSlimRenderers("grep", (a) => oneLine(a?.pattern), grepFinal),
		find: makeSlimRenderers("find", (a) => oneLine(a?.pattern), findFinal),
		ls: makeSlimRenderers("ls", (a) => shortenPath(String(a?.path ?? ".")), lsFinal),
	};

	const apply = (slim: boolean) => {
		slimEnabled = slim;
		for (const [name, def] of Object.entries(base)) {
			if (!def) continue;
			pi.registerTool(slim ? { ...def, renderShell: "self", ...slimByTool[name] } : { ...def });
		}
	};
	apply(true);

	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		const ok = slimDiag.patched.length > 0;
		ctx.ui.notify(
			ok ? `slim-tools: rendering active (${slimDiag.patched.length} module${slimDiag.patched.length === 1 ? "" : "s"})` : "slim-tools: not bound to the host renderer — /slim-diag for details",
			ok ? "info" : "warning",
		);
	});

	pi.registerCommand("slim-diag", {
		description: "Show slim-tools binding diagnostics",
		handler: async (_args, ctx) => {
			const lines = [
				`slim-tools version: ${slimDiag.version}`,
				`patched modules: ${slimDiag.patched.length ? slimDiag.patched.join(", ") : "NONE"}`,
				`wrapper hits: ${slimDiag.wrapperHits}${slimDiag.wrapperHits > 0 ? " (bound ✓)" : " (not bound — stock rendering active)"}`,
				slimDiag.foreignWrapper ? `foreign wrapper detected: ${slimDiag.foreignWrapper}` : "",
				`last gap decisions: ${slimDiag.gapLog.map((g) => `${g.dropped ? "DROP" : "KEEP"}(${g.chain})`).join(" | ") || "none"}`,
			].filter(Boolean);
			ctx.ui.notify(lines.join("\n"), slimDiag.patched.length > 0 ? "info" : "warning");
		},
	});

	pi.registerCommand("slim-tools-off", {
		description: "Restore stock pi tool rendering",
		handler: async (_args, ctx) => {
			apply(false);
			ctx.ui.notify("Stock tool rendering restored", "info");
		},
	});
	pi.registerCommand("slim-tools-on", {
		description: "Re-enable one-line tool rendering",
		handler: async (_args, ctx) => {
			apply(true);
			ctx.ui.notify("One-line tool rendering re-enabled (ctrl+o expands)", "info");
		},
	});
}
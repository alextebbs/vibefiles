// slim-footer.ts — replace pi's default footer with a single line:
//   ~/path (branch) ...... model • thinking • ctx 12.3%/200k
//
// Everything else the default footer shows (token arrows, cache hit rate,
// cost, session name, extension statuses) is dropped. Restore the default
// footer any time with /footer-default; delete this file (or remove it) and
// /reload to uninstall.
import * as os from "node:os";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

function fmtTokens(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}m`;
	if (n >= 1000) return `${(n / 1000).toFixed(0)}k`;
	return `${n}`;
}

function shortenHome(cwd: string): string {
	const home = process.env.HOME || process.env.USERPROFILE || "";
	return home && (cwd === home || cwd.startsWith(home + "/")) ? `~${cwd.slice(home.length)}` : cwd;
}

export default function (pi: ExtensionAPI) {
	let requestRender: (() => void) | undefined;
	const rerender = () => requestRender?.();

	// Redraw when model/thinking changes (footer reads these live in render).
	pi.on("model_select", rerender);
	pi.on("thinking_level_select", rerender);

	pi.on("session_start", async (_event, ctx) => {
		// Footer is a TUI-only feature.
		if (ctx.mode !== "tui") return;

		ctx.ui.setFooter((tui, theme, footerData) => {
			const unsubBranch = footerData.onBranchChange(() => tui.requestRender());
			requestRender = () => tui.requestRender();

			return {
				dispose: () => {
					unsubBranch();
					requestRender = undefined;
				},
				invalidate() {},
				render(width: number): string[] {
					// Left: cwd + branch — same color breakup as the right: no parens,
					// muted tones distinguish the sections.
					const branch = footerData.getGitBranch();
					const cwdStr = theme.fg("muted", shortenHome(ctx.sessionManager.getCwd()));
					const leftFull = branch ? `${cwdStr} ${theme.fg("dim", branch)}` : cwdStr;

					// Right: model / thinking / context% — no dot separators; each section
					// gets its own color so the eye breaks them up.
					const modelStr = theme.fg("accent", ctx.model?.id || "no-model");
					const thinkStr = ctx.model?.reasoning ? theme.fg("muted", ctx.thinkingLevel || "off") : undefined;

					const usage = ctx.getContextUsage();
					const window = usage?.contextWindow ?? ctx.model?.contextWindow ?? 0;
					const winStr = fmtTokens(window);
					const ctxText = usage?.percent != null ? `${usage.percent.toFixed(1)}%/${winStr}` : `?/${winStr}`;
					// Color context by pressure: dim < 70%, warning 70-90, error > 90.
					const severity = usage?.percent != null ? (usage.percent > 90 ? "error" : usage.percent > 70 ? "warning" : "dim") : "dim";
					const ctxStr = theme.fg(severity, ctxText);

					const right = [modelStr, thinkStr, ctxStr].filter(Boolean).join(" ");

					const rightW = visibleWidth(right);
					// Prefer keeping the right side (model/thinking/ctx); drop cwd if it
					// can't fit with ≥2 spaces of separation, shrink it with "…" if too long.
					const leftBudget = width - rightW - 2;
					let left = "";
					if (leftBudget > 4) {
						left = visibleWidth(leftFull) > leftBudget ? truncateToWidth(leftFull, leftBudget, "…") : leftFull;
					}
					const pad = " ".repeat(Math.max(0, width - visibleWidth(left) - rightW));
					return [truncateToWidth((left ? left + pad : "") + right, width)];
				},
			};
		});
	});

	// Escape hatch: restore pi's built-in footer for this session.
	pi.registerCommand("footer-default", {
		description: "Restore the default pi footer",
		handler: async (_args, ctx) => {
			if (ctx.mode !== "tui") return;
			ctx.ui.setFooter(undefined);
			ctx.ui.notify("Default footer restored (slim-footer still installed)", "info");
		},
	});
}
import { readFileSync, writeFileSync } from "fs"
import yaml from "js-yaml"

// ── CLI Parsing ──────────────────────────────────────────────────────────────

function usage() {
    console.log(`Usage: node sim.mjs <rates.yaml> [options...] [conditions...]

Options:
  --runs <count>                     Number of simulation runs (default: 1)
  --output <path>                    Write markdown report to <path>
  --title <title>                    Set the report title

End conditions (repeatable, a run stops when ANY is met):
  --item <name> <count>              Stop when <name> is won <count> times
  --rarity <rarity> <count>          Stop when <rarity> total hits reach <count>
  --type <type> <count>              Stop when <type> total hits reach <count>
  --rarity-spread <rarity> <N> <M>   Stop when <N> distinct <rarity> items each have <M>+ copies
  --pulls <count>                    Stop after <count> total pulls

If no conditions given, runs until Ctrl+C (single run only).`)
    process.exit(1)
}

function parseArgs(argv) {
    if (argv.length < 1) usage()
    const bannerPath = argv[0]
    const conditions = []
    let outputPath = null
    let title = null
    let numRuns = 1
    let i = 1
    while (i < argv.length) {
        const flag = argv[i]
        if (flag === "--item" && i + 2 < argv.length) {
            conditions.push({ kind: "item", name: argv[i + 1], count: parseInt(argv[i + 2], 10) })
            i += 3
        } else if (flag === "--rarity" && i + 2 < argv.length) {
            conditions.push({ kind: "rarity", rarity: argv[i + 1], count: parseInt(argv[i + 2], 10) })
            i += 3
        } else if (flag === "--type" && i + 2 < argv.length) {
            conditions.push({ kind: "type", type: argv[i + 1], count: parseInt(argv[i + 2], 10) })
            i += 3
        } else if (flag === "--rarity-spread" && i + 3 < argv.length) {
            const distinctArg = argv[i + 2]
            const distinctAll = /^(a|all)$/i.test(distinctArg)
            conditions.push({
                kind: "rarity-spread",
                rarity: argv[i + 1],
                distinct: distinctAll ? "all" : parseInt(distinctArg, 10),
                copies: parseInt(argv[i + 3], 10)
            })
            i += 4
        } else if (flag === "--pulls" && i + 1 < argv.length) {
            conditions.push({ kind: "pulls", count: parseInt(argv[i + 1], 10) })
            i += 2
        } else if (flag === "--runs" && i + 1 < argv.length) {
            numRuns = parseInt(argv[i + 1], 10)
            i += 2
        } else if (flag === "--output" && i + 1 < argv.length) {
            outputPath = argv[i + 1]
            i += 2
        } else if (flag === "--title" && i + 1 < argv.length) {
            title = argv[i + 1]
            i += 2
        } else {
            console.error(`Unknown flag or missing arguments: ${flag}`)
            usage()
        }
    }
    if (numRuns > 1 && conditions.length === 0) {
        console.error("--runs requires at least one end condition so each run knows when to stop.")
        process.exit(1)
    }
    return { bannerPath, conditions, outputPath, title, numRuns }
}

// ── Banner Loading ───────────────────────────────────────────────────────────

function loadBanner(path) {
    const raw = readFileSync(path, "utf-8")
    const banner = path.endsWith(".yaml") || path.endsWith(".yml") ? yaml.load(raw) : JSON.parse(raw)
    if (!banner.name) {
        console.error("Invalid banner JSON: must have 'name'.")
        process.exit(1)
    }

    // Flatten sections into items
    if (Array.isArray(banner.sections)) {
        banner.items = []
        for (const section of banner.sections) {
            if (!Array.isArray(section.names) || section.names.length === 0) {
                console.error(`Section missing 'names' array.`)
                process.exit(1)
            }
            if (typeof section.rate !== "string") {
                console.error(`Section rate must be a string (e.g. "0.08333"), got ${typeof section.rate}.`)
                process.exit(1)
            }
            for (const name of section.names) {
                banner.items.push({ name, type: section.type, rarity: section.rarity, rate: section.rate })
            }
        }
    }

    if (!Array.isArray(banner.items) || banner.items.length === 0) {
        console.error("Invalid banner JSON: must have non-empty 'sections' or 'items' array.")
        process.exit(1)
    }
    for (const it of banner.items) {
        if (typeof it.rate !== "string") {
            console.error(`Rate for "${it.name}" must be a string (e.g. "0.08333"), got ${typeof it.rate}.`)
            process.exit(1)
        }
    }

    // Validate that rates sum close to 100%.
    // Game UI truncates at 5 decimal places, so each item can be off by up to 0.000005%.
    const maxDecimals = banner.items.reduce((max, it) => {
        const dot = it.rate.indexOf(".")
        return Math.max(max, dot === -1 ? 0 : it.rate.length - dot - 1)
    }, 0)
    const sum = banner.items.reduce((s, it) => s + rateStringToInt(it.rate, maxDecimals), 0)
    const target = parseInt("100" + "0".repeat(maxDecimals), 10)
    const diff = Math.abs(sum - target)
    const maxError = banner.items.length // each item off by up to 0.5 in the last decimal place
    if (diff > maxError) {
        const pct = (sum / Math.pow(10, maxDecimals)).toFixed(maxDecimals)
        console.error(
            `Rate sum is ${pct}%, which is ${(diff / Math.pow(10, maxDecimals)).toFixed(maxDecimals)}% off from 100%.`
        )
        console.error(
            `Max expected rounding error for ${banner.items.length} items is ${(maxError / Math.pow(10, maxDecimals)).toFixed(maxDecimals)}%.`
        )
        process.exit(1)
    }

    return banner
}

// ── Integer Loot Table ───────────────────────────────────────────────────────
//
// Rates are strings like "0.08333" representing percentages (e.g. 0.08333%).
// We find the max decimal places across all rates, then scale every rate to
// an integer by multiplying by 10^maxDecimals. No floating point involved —
// the string is split at the dot and the fractional part is right-padded.
// The sum of all integer slices becomes the resolution of the roll.

function rateStringToInt(rateStr, maxDecimals) {
    const parts = rateStr.split(".")
    const whole = parts[0] || "0"
    const frac = (parts[1] || "").padEnd(maxDecimals, "0")
    return parseInt(whole + frac, 10)
}

function buildLootTable(items) {
    // Find max decimal places across all rate strings
    const maxDecimals = items.reduce((max, it) => {
        const dot = it.rate.indexOf(".")
        const decimals = dot === -1 ? 0 : it.rate.length - dot - 1
        return Math.max(max, decimals)
    }, 0)

    // Convert each rate string to a precise integer slice
    const slices = items.map((it, idx) => ({
        idx,
        size: rateStringToInt(it.rate, maxDecimals)
    }))

    const resolution = slices.reduce((s, sl) => s + sl.size, 0)
    if (resolution === 0) {
        console.error("All rates are zero — nothing to roll on.")
        process.exit(1)
    }

    // Build cumulative ranges
    const table = []
    let cursor = 0
    for (const sl of slices) {
        if (sl.size > 0) {
            table.push({ start: cursor, end: cursor + sl.size - 1, idx: sl.idx })
            cursor += sl.size
        }
    }
    return { table, resolution }
}

function rollOnTable({ table, resolution }) {
    const roll = Math.floor(Math.random() * resolution)
    // Binary search
    let lo = 0
    let hi = table.length - 1
    while (lo < hi) {
        const mid = (lo + hi) >>> 1
        if (table[mid].end < roll) {
            lo = mid + 1
        } else {
            hi = mid
        }
    }
    return table[lo].idx
}

// ── End Condition Checking ───────────────────────────────────────────────────

function checkConditions(conditions, items, tracker, totalPulls) {
    for (const cond of conditions) {
        if (cond.kind === "pulls" && totalPulls >= cond.count) {
            return cond
        }
        if (cond.kind === "item") {
            const entry = tracker.find((t, i) => items[i].name === cond.name)
            if (entry && entry.count >= cond.count) return cond
        }
        if (cond.kind === "rarity") {
            let total = 0
            for (let i = 0; i < items.length; i++) {
                if (items[i].rarity === cond.rarity) total += tracker[i].count
            }
            if (total >= cond.count) return cond
        }
        if (cond.kind === "type") {
            let total = 0
            for (let i = 0; i < items.length; i++) {
                if (items[i].type === cond.type) total += tracker[i].count
            }
            if (total >= cond.count) return cond
        }
        if (cond.kind === "rarity-spread") {
            let qualified = 0
            for (let i = 0; i < items.length; i++) {
                if (items[i].rarity === cond.rarity && tracker[i].count >= cond.copies) {
                    qualified++
                }
            }
            if (qualified >= cond.distinct) return cond
        }
    }
    return null
}

function describeCondition(cond) {
    if (cond.kind === "pulls") return `${cond.count.toLocaleString()} pulls completed`
    if (cond.kind === "item") return `"${cond.name}" won ${cond.count}x`
    if (cond.kind === "rarity") return `${cond.rarity} won ${cond.count}x total`
    if (cond.kind === "type") return `${cond.type} won ${cond.count}x total`
    if (cond.kind === "rarity-spread")
        return `${cond.distinct} distinct ${cond.rarity} items each at ${cond.copies}+ copies`
    return "unknown"
}

// ── Progress Display ─────────────────────────────────────────────────────────

const RARITY_COLORS = {
    SSR: "\x1b[33m", // yellow
    SR: "\x1b[35m", // magenta
    R: "\x1b[36m" // cyan
}
const RESET = "\x1b[0m"
const DIM = "\x1b[2m"
const BOLD = "\x1b[1m"

function renderProgress(banner, items, tracker, totalPulls, startTime, conditions, currentRun, numRuns) {
    const elapsed = (Date.now() - startTime) / 1000
    const pullsPerSec = elapsed > 0 ? Math.round(totalPulls / elapsed) : 0

    // Gather rarity totals
    const rarityTotals = {}
    for (let i = 0; i < items.length; i++) {
        const r = items[i].rarity
        rarityTotals[r] = (rarityTotals[r] || 0) + tracker[i].count
    }

    let out = "\x1b[2J\x1b[H" // clear + home
    out += `${BOLD}${banner.name}${RESET}\n`
    out += `${DIM}─────────────────────────────────────────${RESET}\n`
    out += `  Run: ${BOLD}${currentRun.toLocaleString()}${RESET} / ${numRuns.toLocaleString()}    `
    out += `Pulls: ${BOLD}${totalPulls.toLocaleString()}${RESET}    ${DIM}(${pullsPerSec.toLocaleString()}/s)${RESET}\n\n`

    // Rarity totals
    const rarityOrder = ["SSR", "SR", "R"]
    for (const r of rarityOrder) {
        if (rarityTotals[r] !== undefined) {
            const color = RARITY_COLORS[r] || ""
            out += `  ${color}${r}${RESET}: ${(rarityTotals[r] || 0).toLocaleString()}\n`
        }
    }
    // Any rarities not in the standard order
    for (const r of Object.keys(rarityTotals)) {
        if (!rarityOrder.includes(r)) {
            out += `  ${r}: ${rarityTotals[r].toLocaleString()}\n`
        }
    }

    // Condition progress
    if (conditions.length > 0) {
        out += `\n${DIM}  End conditions:${RESET}\n`
        for (const cond of conditions) {
            out += `    ${conditionProgress(cond, items, tracker, totalPulls)}\n`
        }
    } else {
        out += `\n${DIM}  Press Ctrl+C to stop and write results.${RESET}\n`
    }

    process.stdout.write(out)
}

function conditionProgress(cond, items, tracker, totalPulls) {
    if (cond.kind === "pulls") {
        const pct = ((totalPulls / cond.count) * 100).toFixed(1)
        return `--pulls ${cond.count.toLocaleString()}: ${totalPulls.toLocaleString()} / ${cond.count.toLocaleString()} (${pct}%)`
    }
    if (cond.kind === "item") {
        const idx = items.findIndex((it) => it.name === cond.name)
        const cur = idx >= 0 ? tracker[idx].count : 0
        return `--item "${cond.name}" ${cond.count}: ${cur} / ${cond.count}`
    }
    if (cond.kind === "rarity") {
        let total = 0
        for (let i = 0; i < items.length; i++) {
            if (items[i].rarity === cond.rarity) total += tracker[i].count
        }
        return `--rarity ${cond.rarity} ${cond.count}: ${total} / ${cond.count}`
    }
    if (cond.kind === "type") {
        let total = 0
        for (let i = 0; i < items.length; i++) {
            if (items[i].type === cond.type) total += tracker[i].count
        }
        return `--type ${cond.type} ${cond.count}: ${total} / ${cond.count}`
    }
    if (cond.kind === "rarity-spread") {
        let qualified = 0
        for (let i = 0; i < items.length; i++) {
            if (items[i].rarity === cond.rarity && tracker[i].count >= cond.copies) qualified++
        }
        return `--rarity-spread ${cond.rarity} ${cond.distinct} ${cond.copies}: ${qualified} / ${cond.distinct} items at ${cond.copies}+`
    }
    return "?"
}

// ── Aggregation ─────────────────────────────────────────────────────────────

function createAggregator(items) {
    return {
        pullsPerRun: [],
        items: items.map(() => ({ counts: [], firstSeens: [] }))
    }
}

function recordRun(agg, tracker, totalPulls) {
    agg.pullsPerRun.push(totalPulls)
    for (let i = 0; i < tracker.length; i++) {
        agg.items[i].counts.push(tracker[i].count)
        agg.items[i].firstSeens.push(tracker[i].firstSeen)
    }
}

function summarize(arr) {
    const sorted = [...arr].sort((a, b) => a - b)
    const sum = sorted.reduce((s, v) => s + v, 0)
    return {
        min: sorted[0],
        max: sorted[sorted.length - 1],
        avg: sum / sorted.length
    }
}

// ── Markdown Output ──────────────────────────────────────────────────────────

function prepareReportData(banner, items, agg, conditions, numRuns) {
    const rows = items.map((it, i) => {
        const countStats = summarize(agg.items[i].counts)
        const validFirstSeens = agg.items[i].firstSeens.filter((v) => v !== null)
        const firstSeenStats = validFirstSeens.length > 0 ? summarize(validFirstSeens) : null
        const nameMatch = it.name.match(/^(.+?)\s*\((.+)\)$/)
        return {
            ...it,
            idx: i,
            id: i + 1,
            countStats,
            firstSeenStats,
            displayName: nameMatch ? nameMatch[1] : it.name,
            style: nameMatch ? nameMatch[2] : ""
        }
    })

    return { rows, pullStats: summarize(agg.pullsPerRun) }
}

function writeMarkdown(outPath, banner, items, agg, conditions, numRuns, title) {
    const { rows, pullStats } = prepareReportData(banner, items, agg, conditions, numRuns)

    const runsLabel = numRuns === 1 ? "1 Run" : `${numRuns.toLocaleString()} Runs`
    const heading = title ? `**${title}** — ${runsLabel}` : `${banner.name} — ${runsLabel}`
    let md = `# ${heading}\n\n`
    md += `**Rates:** ${banner.name}  \n`
    md += `**Date:** ${new Date().toISOString().slice(0, 10)}  \n`
    md += `**Pulls per Run:** min **${pullStats.min.toLocaleString()}** / avg **${Math.round(pullStats.avg).toLocaleString()}** / max **${pullStats.max.toLocaleString()}**  \n`

    if (conditions.length > 0) {
        md += `**End Conditions:** ${conditions.map(describeCondition).join("; ")}  \n`
    }

    md += `\n## Results per Item\n\n`
    md += `| Name | Style | ID | Type | Rarity | Rate | Min | Avg | Max | First Seen (avg) | Every X Pulls (avg) |\n`
    md += `|------|-------|----|------|--------|-----:|----:|----:|----:|-----------------:|--------------------:|\n`

    for (const row of rows) {
        const type = row.type.charAt(0).toUpperCase() + row.type.slice(1)
        const { min, avg, max } = row.countStats
        const firstSeen = row.firstSeenStats ? Math.round(row.firstSeenStats.avg).toLocaleString() : "—"
        const everyX = avg > 0 ? (pullStats.avg / avg).toFixed(1) : "—"
        md += `| **${row.displayName}** | *${row.style}* | *${row.id}* | ${type} | ${row.rarity} | ${row.rate}% | ${min.toLocaleString()} | ${avg.toFixed(1)} | ${max.toLocaleString()} | ${firstSeen} | ${everyX} |\n`
    }

    writeFileSync(outPath, md, "utf-8")
}

function writeHtml(outPath, banner, items, agg, conditions, numRuns, title) {
    const { rows, pullStats } = prepareReportData(banner, items, agg, conditions, numRuns)

    const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    const runsLabel = numRuns === 1 ? "1 Run" : `${numRuns.toLocaleString()} Runs`
    const headingText = title ? `<strong>${esc(title)}</strong> — ${runsLabel}` : `${esc(banner.name)} — ${runsLabel}`
    const titleText = title ? `${esc(title)} — ${runsLabel}` : `${esc(banner.name)} — ${runsLabel}`

    const tableRows = rows
        .map((row) => {
            const type = row.type.charAt(0).toUpperCase() + row.type.slice(1)
            const { min, avg, max } = row.countStats
            const firstSeen = row.firstSeenStats ? Math.round(row.firstSeenStats.avg) : null
            const everyX = avg > 0 ? pullStats.avg / avg : null
            return `            <tr class="rarity-${esc(row.rarity.toLowerCase())}">
                <td><strong>${esc(row.displayName)}</strong></td>
                <td><em>${esc(row.style)}</em></td>
                <td data-sort="${row.id}"><em>${row.id}</em></td>
                <td>${esc(type)}</td>
                <td>${esc(row.rarity)}</td>
                <td data-sort="${row.rate.replace(".", "")}">${esc(row.rate)}%</td>
                <td data-sort="${min}">${min.toLocaleString()}</td>
                <td data-sort="${avg}">${avg.toFixed(1)}</td>
                <td data-sort="${max}">${max.toLocaleString()}</td>
                <td data-sort="${firstSeen ?? 0}">${firstSeen !== null ? firstSeen.toLocaleString() : "—"}</td>
                <td data-sort="${everyX ?? 0}">${everyX !== null ? everyX.toFixed(1) : "—"}</td>
            </tr>`
        })
        .join("\n")

    const conditionsHtml =
        conditions.length > 0 ? `<p><strong>End Conditions:</strong> ${esc(conditions.map(describeCondition).join("; "))}</p>` : ""

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${titleText}</title>
<style>
    :root {
        --bg: #1a1a2e;
        --surface: #16213e;
        --border: #2a2a4a;
        --text: #e0e0e0;
        --dim: #8888aa;
        --ssr: #f0c040;
        --sr: #d070d0;
        --r: #50b8d0;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
        background: var(--bg);
        color: var(--text);
        padding: 2rem;
        line-height: 1.5;
    }
    h1 { color: #fff; margin-bottom: 1rem; font-size: 1.5rem; }
    .meta { margin-bottom: 1.5rem; color: var(--dim); }
    .meta p { margin: 0.2rem 0; }
    .meta strong { color: var(--text); }
    .table-wrap { overflow-x: auto; }
    table {
        width: 100%;
        border-collapse: collapse;
        background: var(--surface);
        border-radius: 8px;
        overflow: hidden;
        font-size: 0.9rem;
    }
    th, td { padding: 0.5rem 0.75rem; text-align: left; border-bottom: 1px solid var(--border); }
    th {
        background: #0f3460;
        color: #fff;
        font-weight: 600;
        cursor: pointer;
        user-select: none;
        white-space: nowrap;
        position: sticky;
        top: 0;
    }
    th:hover { background: #1a4a80; }
    th .arrow { font-size: 0.7rem; margin-left: 0.3rem; opacity: 0.4; }
    th.sorted .arrow { opacity: 1; }
    td:nth-child(n+5) { text-align: right; font-variant-numeric: tabular-nums; }
    th:nth-child(n+5) { text-align: right; }
    tr:hover td { background: rgba(255,255,255,0.03); }
    tr.rarity-ssr td:first-child strong { color: var(--ssr); }
    tr.rarity-sr td:first-child strong { color: var(--sr); }
    tr.rarity-r td:first-child strong { color: var(--r); }
    td em { color: var(--dim); font-style: italic; }
    td strong { font-weight: 600; }
</style>
</head>
<body>
    <h1>${headingText}</h1>
    <div class="meta">
        <p><strong>Rates:</strong> ${esc(banner.name)}</p>
        <p><strong>Date:</strong> ${new Date().toISOString().slice(0, 10)}</p>
        <p><strong>Pulls per Run:</strong> min <strong>${pullStats.min.toLocaleString()}</strong> / avg <strong>${Math.round(pullStats.avg).toLocaleString()}</strong> / max <strong>${pullStats.max.toLocaleString()}</strong></p>
        ${conditionsHtml}
    </div>
    <div class="table-wrap">
        <table id="results">
            <thead>
                <tr>
                    <th>Name <span class="arrow">▲▼</span></th>
                    <th>Style <span class="arrow">▲▼</span></th>
                    <th>ID <span class="arrow">▲▼</span></th>
                    <th>Type <span class="arrow">▲▼</span></th>
                    <th>Rarity <span class="arrow">▲▼</span></th>
                    <th>Rate <span class="arrow">▲▼</span></th>
                    <th>Min <span class="arrow">▲▼</span></th>
                    <th>Avg <span class="arrow">▲▼</span></th>
                    <th>Max <span class="arrow">▲▼</span></th>
                    <th>First Seen (avg) <span class="arrow">▲▼</span></th>
                    <th>Every X Pulls (avg) <span class="arrow">▲▼</span></th>
                </tr>
            </thead>
            <tbody>
${tableRows}
            </tbody>
        </table>
    </div>
<script>
document.querySelectorAll("#results thead th").forEach((th, colIdx) => {
    let asc = true
    th.addEventListener("click", () => {
        const tbody = document.querySelector("#results tbody")
        const rows = Array.from(tbody.querySelectorAll("tr"))
        document.querySelectorAll("#results th").forEach(h => h.classList.remove("sorted"))
        th.classList.add("sorted")
        rows.sort((a, b) => {
            const cellA = a.children[colIdx]
            const cellB = b.children[colIdx]
            const va = cellA.dataset.sort !== undefined ? parseFloat(cellA.dataset.sort) : cellA.textContent.trim().toLowerCase()
            const vb = cellB.dataset.sort !== undefined ? parseFloat(cellB.dataset.sort) : cellB.textContent.trim().toLowerCase()
            if (typeof va === "number" && typeof vb === "number") return asc ? va - vb : vb - va
            if (va < vb) return asc ? -1 : 1
            if (va > vb) return asc ? 1 : -1
            return 0
        })
        rows.forEach(r => tbody.appendChild(r))
        th.querySelector(".arrow").textContent = asc ? "▲" : "▼"
        asc = !asc
    })
})
</script>
</body>
</html>`

    writeFileSync(outPath, html, "utf-8")
}

function writeReport(outPath, banner, items, agg, conditions, numRuns, title) {
    const hasExt = /\.\w+$/.test(outPath)
    if (!hasExt) {
        writeMarkdown(outPath + ".md", banner, items, agg, conditions, numRuns, title)
        writeHtml(outPath + ".html", banner, items, agg, conditions, numRuns, title)
    } else if (outPath.endsWith(".html") || outPath.endsWith(".htm")) {
        writeHtml(outPath, banner, items, agg, conditions, numRuns, title)
    } else {
        writeMarkdown(outPath, banner, items, agg, conditions, numRuns, title)
    }
}

// ── Main ─────────────────────────────────────────────────────────────────────

const { bannerPath, conditions, outputPath, title, numRuns } = parseArgs(process.argv.slice(2))
const banner = loadBanner(bannerPath)
const { items } = banner

// Resolve "all" in rarity-spread conditions
for (const cond of conditions) {
    if (cond.kind === "rarity-spread" && cond.distinct === "all") {
        cond.distinct = items.filter((it) => it.rarity === cond.rarity).length
    }
}

const lootTable = buildLootTable(items)
console.log(`Loot table resolution: ${lootTable.resolution.toLocaleString()} (${lootTable.table.length} slots)`)

const agg = createAggregator(items)
let currentRun = 1
let tracker = items.map(() => ({ count: 0, firstSeen: null }))
let totalPulls = 0
let stopped = false
let triggeredCondition = null
const startTime = Date.now()

process.on("SIGINT", () => {
    stopped = true
})

function finishRun() {
    recordRun(agg, tracker, totalPulls)
}

function finishAll() {
    renderProgress(banner, items, tracker, totalPulls, startTime, conditions, currentRun, numRuns)
    if (outputPath) {
        writeReport(outputPath, banner, items, agg, conditions, numRuns, title)
        const hasExt = /\.\w+$/.test(outputPath)
        if (!hasExt) {
            console.log(`\n\n  Results written to: ${outputPath}.md, ${outputPath}.html`)
        } else {
            console.log(`\n\n  Results written to: ${outputPath}`)
        }
    } else {
        console.log("\n")
    }
}

function resetRun() {
    tracker = items.map(() => ({ count: 0, firstSeen: null }))
    totalPulls = 0
    triggeredCondition = null
}

// Simulation loop — yields to the event loop periodically so SIGINT can fire
function runChunk() {
    const chunkEnd = Date.now() + 100
    while (!stopped && Date.now() < chunkEnd) {
        const idx = rollOnTable(lootTable)
        totalPulls++
        tracker[idx].count++
        if (tracker[idx].firstSeen === null) tracker[idx].firstSeen = totalPulls

        if (conditions.length > 0) {
            triggeredCondition = checkConditions(conditions, items, tracker, totalPulls)
            if (triggeredCondition) {
                finishRun()
                currentRun++
                if (currentRun > numRuns) {
                    finishAll()
                    return
                }
                resetRun()
            }
        }
    }

    if (stopped) {
        finishRun()
        finishAll()
        return
    }

    renderProgress(banner, items, tracker, totalPulls, startTime, conditions, currentRun, numRuns)
    setImmediate(runChunk)
}

runChunk()

import { readFileSync, writeFileSync, mkdirSync } from "fs"
import { join } from "path"

// ── CLI Parsing ──────────────────────────────────────────────────────────────

function usage() {
    console.log(`Usage: node sim.mjs <rates.json> [conditions...]

Conditions (repeatable, simulation stops when ANY is met):
  --item <name> <count>              Stop when <name> is won <count> times
  --rarity <rarity> <count>          Stop when <rarity> total hits reach <count>
  --type <type> <count>              Stop when <type> total hits reach <count>
  --rarity-spread <rarity> <N> <M>   Stop when <N> distinct <rarity> items each have <M>+ copies
  --runs <count>                     Stop after <count> total pulls

If no conditions given, runs until Ctrl+C.`)
    process.exit(1)
}

function parseArgs(argv) {
    if (argv.length < 1) usage()
    const bannerPath = argv[0]
    const conditions = []
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
            conditions.push({
                kind: "rarity-spread",
                rarity: argv[i + 1],
                distinct: parseInt(argv[i + 2], 10),
                copies: parseInt(argv[i + 3], 10)
            })
            i += 4
        } else if (flag === "--runs" && i + 1 < argv.length) {
            conditions.push({ kind: "runs", count: parseInt(argv[i + 1], 10) })
            i += 2
        } else {
            console.error(`Unknown flag or missing arguments: ${flag}`)
            usage()
        }
    }
    return { bannerPath, conditions }
}

// ── Banner Loading ───────────────────────────────────────────────────────────

function loadBanner(path) {
    const raw = readFileSync(path, "utf-8")
    const banner = JSON.parse(raw)
    if (!banner.name || !Array.isArray(banner.items) || banner.items.length === 0) {
        console.error("Invalid banner JSON: must have 'name' and non-empty 'items' array.")
        process.exit(1)
    }
    for (const it of banner.items) {
        if (typeof it.rate !== "string") {
            console.error(`Rate for "${it.name}" must be a string (e.g. "0.08333"), got ${typeof it.rate}.`)
            process.exit(1)
        }
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
        if (cond.kind === "runs" && totalPulls >= cond.count) {
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
    if (cond.kind === "runs") return `${cond.count.toLocaleString()} pulls completed`
    if (cond.kind === "item") return `"${cond.name}" won ${cond.count}x`
    if (cond.kind === "rarity") return `${cond.rarity} won ${cond.count}x total`
    if (cond.kind === "type") return `${cond.type} won ${cond.count}x total`
    if (cond.kind === "rarity-spread") return `${cond.distinct} distinct ${cond.rarity} items each at ${cond.copies}+ copies`
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

function renderProgress(banner, items, tracker, totalPulls, startTime, conditions) {
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
    out += `  Pulls: ${BOLD}${totalPulls.toLocaleString()}${RESET}    ${DIM}(${pullsPerSec.toLocaleString()}/s)${RESET}\n\n`

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
    if (cond.kind === "runs") {
        const pct = ((totalPulls / cond.count) * 100).toFixed(1)
        return `--runs ${cond.count.toLocaleString()}: ${totalPulls.toLocaleString()} / ${cond.count.toLocaleString()} (${pct}%)`
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

// ── Markdown Output ──────────────────────────────────────────────────────────

function writeReport(banner, items, tracker, totalPulls, conditions, triggeredCondition) {
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)
    const safeName = banner.name.replace(/[^a-zA-Z0-9]+/g, "_").toLowerCase()
    const filename = `${safeName}_${timestamp}.md`
    const outPath = join("output", filename)

    mkdirSync("output", { recursive: true })

    // Sort items by rarity order, then count desc
    const rarityRank = { SSR: 0, SR: 1, R: 2 }
    const sorted = items
        .map((it, i) => ({ ...it, ...tracker[i], idx: i }))
        .sort((a, b) => {
            const ra = rarityRank[a.rarity] ?? 99
            const rb = rarityRank[b.rarity] ?? 99
            if (ra !== rb) return ra - rb
            return b.count - a.count
        })

    let md = `# ${banner.name} — Simulation Results\n\n`
    md += `**Date:** ${new Date().toISOString().slice(0, 10)}  \n`
    md += `**Total Pulls:** ${totalPulls.toLocaleString()}  \n`

    if (conditions.length > 0) {
        md += `**End Conditions:** ${conditions.map(describeCondition).join("; ")}  \n`
    }
    if (triggeredCondition) {
        md += `**Triggered By:** ${describeCondition(triggeredCondition)}  \n`
    }

    md += `\n## Results per Item\n\n`
    md += `| Name | Type | Rarity | Count | First Seen | Avg Pull Gap |\n`
    md += `|------|------|--------|------:|----------:|-----------:|\n`

    for (const row of sorted) {
        const firstSeen = row.firstSeen === null ? "—" : row.firstSeen.toLocaleString()
        const avgGap = row.count > 0 ? (totalPulls / row.count).toFixed(1) : "—"
        md += `| ${row.name} | ${row.type} | ${row.rarity} | ${row.count.toLocaleString()} | ${firstSeen} | ${avgGap} |\n`
    }

    md += `\n## Input Rates\n\n`
    md += `| Name | Type | Rarity | Rate |\n`
    md += `|------|------|--------|-----:|\n`
    for (const it of items) {
        md += `| ${it.name} | ${it.type} | ${it.rarity} | ${it.rate}% |\n`
    }

    writeFileSync(outPath, md, "utf-8")
    return outPath
}

// ── Main ─────────────────────────────────────────────────────────────────────

const { bannerPath, conditions } = parseArgs(process.argv.slice(2))
const banner = loadBanner(bannerPath)
const { items } = banner
const lootTable = buildLootTable(items)
console.log(`Loot table resolution: ${lootTable.resolution.toLocaleString()} (${lootTable.table.length} slots)`)

// Per-item tracking
const tracker = items.map(() => ({ count: 0, firstSeen: null }))

let totalPulls = 0
let stopped = false
let triggeredCondition = null
const startTime = Date.now()
let lastRender = 0

process.on("SIGINT", () => {
    stopped = true
})

// Simulation loop
while (!stopped) {
    const idx = rollOnTable(lootTable)
    totalPulls++
    tracker[idx].count++
    if (tracker[idx].firstSeen === null) tracker[idx].firstSeen = totalPulls

    // Check end conditions
    if (conditions.length > 0) {
        triggeredCondition = checkConditions(conditions, items, tracker, totalPulls)
        if (triggeredCondition) break
    }

    // Throttled progress display
    const now = Date.now()
    if (now - lastRender >= 200) {
        renderProgress(banner, items, tracker, totalPulls, startTime, conditions)
        lastRender = now
    }
}

// Final render + output
renderProgress(banner, items, tracker, totalPulls, startTime, conditions)
const outPath = writeReport(banner, items, tracker, totalPulls, conditions, triggeredCondition)
console.log(`\n\n  Results written to: ${outPath}`)

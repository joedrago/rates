# Gacha Banner Monte Carlo Simulator

A Node.js CLI tool that runs monte carlo simulations against gacha game banner rate tables and outputs markdown reports.

## What It Does

Given a JSON file describing a gacha banner's loot table (items, rarities, types, and their drop rate percentages), the simulator rolls millions of pulls and tracks:

- How many times each item was obtained
- Which pull number each item first appeared on
- Average pull gap per item (total pulls / times obtained)

Results are written to a timestamped markdown file in `output/`.

## How the Rolling Works

Rates in the JSON are **strings**, copied verbatim from the in-game rate display (e.g. `"0.08333"`). These are never parsed as floats. Instead, the simulator converts them to precise integers:

1. Find the longest fractional part across all rate strings
2. Pad all rates to that length and strip the decimal point, yielding exact integers (e.g. `"0.08333"` becomes `8333`, `"4.50000"` becomes `450000`)
3. Each item gets an integer-width slice of the roll range
4. The sum of all slices becomes the roll resolution
5. Each pull: `Math.floor(Math.random() * resolution)` → binary search into the range table

No floating-point arithmetic touches the rate math. What you type from the game UI is what the simulator uses.

## Rate File Format

Rate files live in `rates/` as YAML (`.yaml`/`.yml`) or JSON. YAML is preferred for hand-editing.

```yaml
name: "Banner Name"
sections:
  - type: character
    rarity: SSR
    rate: "0.08333"
    names:
      - Luna
      - Seira
      - Elisa

  - type: equipment
    rarity: R
    rate: "12.0000"
    names:
      - Common Sword
      - Iron Shield
```

- **name**: Display name for the banner
- **sections[]**: Groups of items sharing the same type, rarity, and rate
- **sections[].type**: Category like "character", "equipment", etc. (string)
- **sections[].rarity**: Rarity tier like "SSR", "SR", "R" (string)
- **sections[].rate**: Drop rate percentage as shown in-game (string, e.g. `"0.08333"` means 0.08333%)
- **sections[].names**: Array of item/character names (strings)

The legacy flat JSON `items` array format is also still supported.

Rates don't need to sum to exactly 100% — the simulator uses proportional weighting from whatever the sum is.

## Usage

```
node sim.mjs <rates.json> [conditions...]
```

### End Conditions

All flags are repeatable. The simulation stops when **any one** condition is met.

| Flag | Args | Stops when... |
|------|------|---------------|
| `--item` | `<name> <count>` | Named item is won `<count>` times |
| `--rarity` | `<rarity> <count>` | Total hits of that rarity reach `<count>` |
| `--type` | `<type> <count>` | Total hits of that type reach `<count>` |
| `--rarity-spread` | `<rarity> <N> <M>` | `<N>` distinct items of that rarity each have `<M>`+ copies |
| `--runs` | `<count>` | `<count>` total pulls are completed |

If no conditions are given, runs until Ctrl+C.

### Examples

```bash
# Run 1 million pulls
node sim.mjs rates/starsavior_standard.yaml --runs 1000000

# Stop when Claire is pulled 5 times
node sim.mjs rates/starsavior_standard.yaml --item "Claire" 5

# Multiple conditions — stops on whichever hits first
node sim.mjs rates/starsavior_standard.yaml --item "Claire" 5 --item "Lacy" 3 --rarity SSR 50

# Stop when 4 different SSR characters each have 4+ copies
node sim.mjs rates/starsavior_standard.yaml --rarity-spread SSR 4 4

# Run indefinitely, Ctrl+C to stop and write results
node sim.mjs rates/starsavior_standard.yaml
```

## Output

While running, a live progress display shows total pulls, pulls/sec, per-rarity totals, and progress toward each end condition.

When finished, a markdown report is written to `output/<banner-name>_<timestamp>.md` containing:

1. **Results per Item** — count, first seen pull #, average pull gap, sorted by rarity then count
2. **Input Rates** — the raw rate table from the JSON file

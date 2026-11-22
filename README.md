# list-cleaner

The engine behind the list-cleaning SaaS (working name). It takes a business list from Google Maps (the Maps Directory Collector, Outscraper, Apify, or any CSV/XLSX) and sorts it into **Keep / Review / Remove** using:

1. **Free filter:** duplicates, closed businesses, unrelated categories and names.
2. **Website check:** reads the homepage and one relevant inner page. Sites that block plain requests or build their text with JavaScript are opened in headless Chrome.
3. **Jev** (TypeSafe): typed yes/no judgments for businesses with evidence.

What gets kept is set by a **template**. The first is **Directory builder**, ported from the extension's cleaner (v2.5.5). More templates (web design leads, stockist finder…) plug into the same engine.

## Setup

Needs Node 20+.

```bash
git clone https://github.com/sdev44/list-cleaner
cd list-cleaner
npm install
npm test
```

Put your Jev key in a `.env` file in the folder you run from (never commit it):

```
JEV_API_KEY=your-key-here
```

## Use

```bash
# See how your columns were matched
npm run cli -- inspect Kansas-All.xlsx

# Clean a list (target area worked out from the list if --area is left out)
npm run cli -- clean Kansas-All.xlsx --area KS --out out/kansas.xlsx

# Test run: only check 50 businesses after the free filter
npm run cli -- clean Kansas-All.xlsx --limit 50

# A new directory: write starter rules, check them, improve them with Jev, then clean
npm run cli -- rules dog-groomers.xlsx --name "Dog Grooming" --out dog-rules.json
npm run cli -- suggest-rules dog-groomers.xlsx --rules dog-rules.json
npm run cli -- clean dog-groomers.xlsx --rules dog-rules.json --area UK
```

The output workbook has **Clean**, **Review** and **Rejected** sheets (plus **Not checked** for limited runs) and a **Summary**. Website and Maps links are clickable.

- **Stop and resume:** press Ctrl+C. Progress is saved next to the output (`*.state.json`). Running the same command again carries on. Add `--fresh` to start again.
- **Other column names:** `--map website="Company URL",name=Title`.
- **No key:** businesses that need a judgment go to Review (or Clean on a strong keyword score).
- **Headless browser:** uses your installed Google Chrome (or Edge). Without either, run `npx playwright-core install chromium` once. `--no-browser` turns it off.

## Diagnosing unreadable websites

```bash
npm run cli -- diagnose out/kansas-new.xlsx
```

Retries every site the results file marked unreachable or nearly empty, first with a plain request, then in the browser. It prints why each one failed (HTTP 403, timeout, certificate error…) and saves the details to a CSV.

## Live accuracy test (Kansas)

This repeats the extension's Kansas run with the new engine and compares the results. It costs roughly 1–2p in Jev usage.

```bash
npm run cli -- clean Kansas-All.xlsx --area KS --out out/kansas-new.xlsx
npm run cli -- compare Kansas-Clean.xlsx Kansas-Review.xlsx Kansas-Rejected.xlsx out/kansas-new.xlsx --out out/kansas-diff.csv
```

`compare` prints a table of old vs new results and saves every difference with both reasons. Expect some differences that aren't errors:

- **35 fabricators** the extension removed for free are now checked properly (see "Changes from the extension").
- **Jev answers vary slightly** between runs, so borderline businesses can move between Clean and Review.

Then hand-check ~50 businesses from the new **Clean** sheet to measure how often Clean is right.

## Parity with the extension

`npm test` includes a check against the extension's real Kansas results (3,293 businesses):

- **Free filter:** identical decision and reason for all 3,293 in legacy mode.
- **Jev decision rules:** replaying the extension's recorded Jev answers gives the same result for 124 of 125. The one difference comes from the extension not storing Jev's probability for "doesn't serve Kansas" (`npx tsx scripts/parity.ts All.xlsx Clean.xlsx Review.xlsx Rejected.xlsx`).

## Changes from the extension

| Change | Why |
|---|---|
| `protectPlausible` (on by default): a category on the "could offer it" list is never removed by the free category filter | The extension removed "Metal fabricator", "Steel Fabricator" and "Plastic fabrication company" because `fabric` (fabric shops) is excluded. In Kansas that removed 35 businesses unchecked, including **DEFCON Underground Mfg.** Set `"protectPlausible": false` in rules to reproduce the extension exactly. |
| Inner page picked from same-site links only | The extension took the first matching link anywhere. One off-site "storm" link (e.g. to a manufacturer) stopped it reading the business's own shelter page. |
| Headless Chrome instead of a hidden tab | Same job: sites that refuse plain requests or need JavaScript. Up to 3 at a time; images and fonts skipped for speed. |
| Service area: "partly" answer | Jev can say a business based elsewhere reaches only part of the area (install radius, region, delivery, drop-shipping). That goes to Review by default with the evidence quoted (`"partialArea": "review"`; or `"keep"` / `"remove"`). A business is never rejected on area when its site mentions a radius, delivery or shipping. |
| Second opinion | Borderline answers (supplies near the Clean line, a weak "doesn't serve", or "partly") are asked twice. Probabilities are averaged and disagreement counts as unclear, so one wobbly answer can't reject a business. The **Jev Asks** column shows 1 or 2. |
| Evidence for Jev | Reads up to two inner pages (the niche page and a service-area/locations page) and keeps the homepage footer, where addresses and service areas usually sit. |
| Column mapping | Reads Outscraper, Apify and collector exports. Unknown columns are kept and passed through. |
| One workbook out | Clean / Review / Rejected sheets plus a summary, instead of separate downloads. |

## Layout

```
src/
  core/            generic engine: areas, columns, site reading, Jev client, pipeline, export
  templates/
    directory/     Directory builder (rules.ts = presets + starter rules, index.ts = logic)
    index.ts       template registry
  cli.ts           command-line runner
  index.ts         library entry for the future web app
scripts/parity.ts  parity check against an extension batch
test/              unit tests, mocked end-to-end runs, Kansas parity fixture
```

## Adding a template

Create `src/templates/<id>/index.ts` that exports a `Template` (see `src/core/template.ts`):

- `prefilter`: free checks over the whole list
- `check`: per business (read the site, ask the classifier, decide)
- `columns`: extra output columns
- `outcomeLabels`: what Keep / Review / Remove are called
- `defaultRules` / `parseRules`: the template's own settings

Then register it in `src/templates/index.ts`.

## Known limits

- US states and UK nations only for the target area.
- Sites with strong bot protection (CAPTCHAs) stay unreadable and go to Review.
- `exceljs` depends on an old `uuid` (moderate `npm audit` warning, not reachable from this tool's use).

# Etsy Bulk Sale Creator

A Chrome extension that automates the Etsy sale creation flow. Upload a CSV file with your sale details and the extension fills every form field, selects your shop sections, and either stops at the review page for you to check, or confirms and creates all sales in sequence.

---

## Features

- **Bulk import** — run every row in a CSV as a separate sale, back to back
- **Dry Run mode** — processes row 1 and stops at the review page without creating anything, so you can verify your CSV is correct
- **CSV validation** — catches errors upfront (duplicate names, invalid dates, bad discount values) before anything runs
- **Date offset correction** — Etsy displays the end date as one day later than entered; the extension subtracts one day automatically so your sale ends on the date you intend
- **Category matching warnings** — if a shop section name in your CSV doesn't match Etsy's dropdown exactly, you're told which ones failed rather than silently skipping them
- **Step-by-step progress panel** — live indicator showing which automation step is running, with success/warning/error states

---

## Installation

### Chrome Web Store (recommended)

Install directly from the [Chrome Web Store](https://chromewebstore.google.com/detail/etsy-bulk-sale-creator/caijnkaagjkkiijihefpeajcoofmcebm) — no setup required.

### Load unpacked (local)

1. Download or clone this repository
2. Open Chrome and go to `chrome://extensions`
3. Enable **Developer mode** (toggle in the top right)
4. Click **Load unpacked**
5. Select the folder containing `manifest.json`

The extension will appear in your toolbar. It only activates on Etsy's sales-discounts pages.

---

## Usage

1. Go to `https://www.etsy.com/your/shops/me/sales-discounts`
2. Click the **⚡ Auto Sale** button in the bottom-right corner
3. Download the CSV template using the link in the modal
4. Fill in your sale details and upload the file
5. Review the imported rows — errors and warnings are shown inline
6. Choose a run mode:
   - **Test Run** — runs row 1 only, stops at the review page (nothing is created)
   - **Import Sales** — runs all rows and confirms each sale (only enabled when all rows pass validation)

---

## CSV Format

Download the template from inside the extension or use the example below.

| Column | Required | Description |
|--------|----------|-------------|
| `sale_name` | Yes | Unique identifier for the sale. Letters and numbers only, max 20 characters. Buyers never see this. |
| `discount_type` | Yes | `percent` or `free_shipping` |
| `discount_percentage` | When `percent` | Integer between 1 and 99 |
| `region` | Yes | `Everywhere` or any country name as it appears in Etsy's dropdown (e.g. `United Kingdom`) |
| `start_date` | Yes | `DD/MM/YYYY` — the date you want the sale to start |
| `end_date` | Yes | `DD/MM/YYYY` — the date you want the sale to **end**. The extension subtracts one day before submitting to correct Etsy's display offset. |
| `categories` | Yes | Pipe-separated list of shop section names exactly as they appear in Etsy: `Widgets\|Emotes\|Panels` |

### Example

```csv
sale_name,discount_type,discount_percentage,region,start_date,end_date,categories
SPRINGSALE26,percent,20,Everywhere,02/05/2026,01/06/2026,Widgets|Emotes
SUMMERSALE26,percent,25,United Kingdom,01/07/2026,30/07/2026,Panels|Screens
FREESHIP26,free_shipping,,Everywhere,01/08/2026,31/08/2026,Widgets
```

### Validation rules

- `sale_name` must be unique within the CSV — Etsy also requires uniqueness across your entire shop history
- `end_date` must be after `start_date`
- Sale duration is capped at 30 days by Etsy — the extension warns if a row exceeds this
- Category names are case-sensitive and must match your shop section names exactly
- **Test Run** is available as long as row 1 is valid, even if other rows have errors
- **Import Sales** requires every row to be valid before it enables

---

## How the end date offset works

If you enter `22/05/2026` as the end date in Etsy's form, Etsy displays it as ending on the 23rd. To avoid confusion, put the date you actually want the sale to end in the CSV. The extension automatically subtracts one day before submitting, so Etsy's display matches your intention.

---

## Automation flow

For each row, the extension:

1. Clicks the **Set up** link to open the sale creation dialog
2. Fills in discount type, percentage, region, start date, end date, and sale name
3. Clicks **Continue**
4. Selects the **Select listings** radio option
5. Opens the **Add listings by shop section** dropdown and clicks each matching category
6. Clicks **Review and confirm** → clicks **Done** on the listing confirmation overlay
7. *(Import mode only)* Clicks **Confirm and create sale** → clicks **Done** on the success overlay → moves to the next row

---

## Notes

- The extension only injects the trigger button on `sales-discounts` and `sales-discounts/step/*` pages — it is invisible everywhere else
- Refreshing the page mid-automation safely cancels the current run rather than restarting it
- The extension does not store, transmit, or log any of your sale data — everything runs locally in the browser

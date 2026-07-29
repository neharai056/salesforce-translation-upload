# Salesforce Translation Matrix (Chrome extension)

A spreadsheet-style editor for Custom Label and Validation Rule translations,
so you don't have to click through Translation Workbench one language/record
at a time.

## How it works

- **Auth**: reads the `sid` session cookie from whichever Salesforce tab is
  active when you click the extension icon. No separate login/OAuth.
- **Default values**: Custom Label and Validation Rule *default-language*
  text comes from the **Tooling API** (`ExternalString`, `ValidationRule`).
- **Translations**: per-language text isn't queryable via REST — it lives in
  **Translations metadata** (one `.translation` file per active language).
  The extension uses the **Metadata API** (`listMetadata` → `retrieve` →
  unzip → edit → re-zip → `deploy`) to read and write it.
- **UI**: opens as its own browser tab (`matrix.html`) with a frozen name
  column, one column per org language, inline editing, and a save bar that
  only deploys what changed.

## One-time setup

1. **Add the zip library.** The extension needs `fflate` to unzip/rezip the
   Metadata API retrieve/deploy payloads. Download the minified build and
   save it as `lib/fflate.min.js`:
   - https://cdnjs.cloudflare.com/ajax/libs/fflate/0.8.2/fflate.min.js

   (It's vendored locally rather than loaded from a CDN at runtime, since
   Manifest V3 extensions shouldn't fetch remote code.)

2. **Load the extension.**
   - Go to `chrome://extensions`
   - Enable **Developer mode** (top right)
   - **Load unpacked** → select this folder

3. **Use it.**
   - Open your Salesforce org (Setup, Lightning, anywhere) in a tab.
   - Click the extension icon → **Open matrix**.
   - It opens a new tab, discovers your org's active Translation Workbench
     languages, and loads Custom Labels / Validation Rules side by side.
   - Edit any cell inline. Edited cells get an amber left border.
   - Click **Save changes** to deploy only the edited translations.

## Known limitations / things to review before relying on this

- **Discovering languages**: it lists languages via `listMetadata` for the
  `Translations` type, which only returns a language once Translation
  Workbench has created a file for it (this normally happens the moment you
  add the language under Setup → Translation Workbench → Language Settings,
  even before you enter any values). If a language you expect is missing,
  confirm it's active there.
- **Large orgs**: Tooling `query` results are paginated (2,000 records per
  call, and the Translations metadata retrieve isn't chunked here). For very
  large label/rule counts you may need to add pagination via the
  `nextRecordsUrl` field, which the current `toolingQuery` doesn't follow yet.
- **Conflict handling**: deploys use `rollbackOnError: true`, so a bad row
  fails the whole batch — the error list from `componentFailures` is shown
  but not yet mapped back to specific grid cells.
- **Permissions**: the user running this needs "Modify All Data" or
  equivalent Metadata API deploy access, same as manually editing Translation
  Workbench.
- **Other translatable types**: the same pattern (retrieve/edit/deploy on
  `Translations`) extends to picklist values, field labels, page layouts,
  etc. — those live in the same XML file under different child tags
  (`picklists`, `fields`, `layouts`...) if you want to widen the grid later.

## File structure

```
manifest.json         Extension manifest (MV3)
background.js          Session capture + Tooling REST + Metadata SOAP calls
popup.html/js          Toolbar button → detects org, opens matrix tab
matrix/matrix.html      Grid page shell
matrix/matrix.css       Styling
matrix/matrix.js        Data loading, rendering, edit tracking, deploy
lib/fflate.min.js       (you add this) zip/unzip for retrieve & deploy payloads
```

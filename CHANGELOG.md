# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.0.0] - unreleased

## [0.1.0]

### Added
- Open the radar service (AGPL) and add own-fill sync opt-in.
- MCP installable package with its own analysis core, plus bring-your-own-CLI docs.
- Free test phase for Socio SWAL and Telegram alerts in the guardian.
- Assisted-install page (switched off until configured).
- Heartbeat dead-man for the local guardian and radar.
- Chart bridge daemon and control HTTP API.
- Support client mode for chart bridge tools.
- Ship swal-bridge systemd user service unit.
- Switch to Trading View tab before painting and offer return to Original.
- Locate and switch Binance chart tabs via DOM helpers.
- Extension side panel footer with site links.
- Clear CTA row to landing hero.
- Extension landing page and manual install zip.
- Apoyar page and volunteer support links.
- Local radar host permission and privacy disclosures in extension.
- RadarCard component to side panel.
- Radar read and note tools for local swal-radar in MCP.
- Radar client library with strict sanitization and tests.
- RadarEnabled and radarPort settings with validation.

### Changed
- Bundle the analysis core in npm run build instead of a prepack hook.
- Sync the public guardian with the maintained version and bring the README up to date.
- Remove the assisted-install page (everything stays free for now).
- Cap the AI explainer at 60 calls/day and turn on Worker logs.
- Rebuild the extension download from the integrated panel.
- Differentiate honesty note by measured pattern kind.

### Fixed
- Verify-pack always closes the client, even when an assertion fails.
- Guardian free tier now shows Telegram.
- Create the backup_rate_limits table that `/api/backup` needs.
- Recognise the active Binance chart tab class.
- Let the content script finish setup and paint after a tab switch.
- Compute daily pnl and alerts over all positions in free tier.
- Radar shows 'Entrada superada' and drops unknown statuses.
- Say when the chart bridge port is owned by another session.

### Security
- Core license is now strictly `AGPL-3.0-only`.

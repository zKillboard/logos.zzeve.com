# Alliance Logos Tracker

A web application that tracks and displays custom alliance logos in EVE Online. This project automatically monitors all alliances in the game to detect when they upload custom logos and presents them in an organized, chronological format.

## 🚀 Live Site

Visit [logos.zzeve.com](https://logos.zzeve.com) to see the latest alliance logos.

## 📖 Overview

EVE Online alliances can upload custom logos to personalize their organizations. This project:

- **Tracks all alliances** in EVE Online via the ESI (EVE Swagger Interface) API
- **Detects new custom logos** by monitoring image endpoints
- **Organizes logos chronologically** by when they were first detected and when alliances were founded
- **Generates a clean web interface** to browse and discover alliance logos
- **Updates automatically** via GitHub Actions on a weekly schedule

## 🏗️ Architecture

### Data Flow
1. **Fetch Alliance List**: Retrieves all alliance IDs from ESI API
2. **Check for New Alliances**: Adds metadata for any previously unknown alliances
3. **Logo Detection**: Checks image endpoints to detect custom logos (non-default images)
4. **Data Storage**: Stores alliance data and logo status in SQLite database
5. **Web Generation**: Creates static HTML page and JSON data file
6. **Auto-Deploy**: GitHub Pages serves the updated content

### Key Files
- `app.js` - Main application logic for data fetching and processing
- `docs/index.html` - Generated static website
- `docs/alliances_with_logos.json` - JSON API endpoint with alliance data
- `alliances.db` - SQLite database storing alliance information
- `.github/workflows/weekly-logo-update.yml` - Automated update workflow

## 🛠️ Technology Stack

- **Runtime**: Node.js 20
- **Database**: SQLite (via better-sqlite3)
- **HTTP Client**: node-fetch
- **Frontend**: Bootstrap 2.2.2, jQuery 1.8.3
- **Hosting**: GitHub Pages
- **Automation**: GitHub Actions
- **APIs**: EVE Online ESI API, EVE Image Server

## 🔄 Automated Updates

The project runs automatically every Tuesday at 13:00 UTC via GitHub Actions:

1. Fetches latest alliance data from ESI
2. Checks for new custom logos
3. Updates the database and generated files
4. Commits changes back to the repository
5. GitHub Pages automatically deploys the updates

## 🎯 Features

### Website Features
- **Latest Logos**: Shows the most recently detected custom logos
- **Historical View**: Organizes alliances by their founding month/year
- **Direct Links**: Each logo links to the alliance's zKillboard page
- **Responsive Design**: Works on desktop and mobile devices

### Data Features
- **Comprehensive Tracking**: Monitors all EVE Online alliances
- **Logo Detection**: Identifies custom logos vs. default placeholders
- **Historical Data**: Tracks when logos were first detected
- **JSON API**: Provides structured data for other applications

## 🚀 Local Development

### Prerequisites
- Node.js 20 or later
- Git

### Setup
```bash
# Clone the repository
git clone https://github.com/zKillboard/logos.zzeve.com.git
cd logos.zzeve.com

# Install dependencies (no package.json needed)
npm install better-sqlite3@^12.2.0 node-fetch@^3.3.2 --no-package-lock --no-save

# Run the application
node app.js
```

### Manual Testing
```bash
# Check the generated files
ls -la docs/
cat docs/alliances_with_logos.json | head -20

# View the website locally
# Open docs/index.html in your browser
```

## 📊 Data Structure

### Alliance Database Schema
```sql
CREATE TABLE alliances (
  id INTEGER PRIMARY KEY,           -- Alliance ID from ESI
  ticker TEXT,                      -- Alliance ticker/abbreviation
  startDate TEXT,                   -- Alliance founding date (ISO format)
  size INTEGER,                     -- Logo file size in bytes
  has_custom_logo BOOLEAN,          -- Whether alliance has custom logo
  logoSince TEXT,                   -- Date when logo was first detected
  last_checked TEXT                 -- Last time this alliance was checked
);
```

### JSON Output Format
```json
{
  "newest": [                       // Latest logos detected
    {
      "id": 99007335,
      "ticker": "HABIT",
      "logoSince": "2025-10-28",
      "startDate": "2017-03-26T06:06:02Z"
    }
  ],
  "hasLogos": {                     // Grouped by alliance founding month
    "2024-03": [...],
    "2023-12": [...]
  }
}
```

## 🤝 Contributing

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Make your changes
4. Test locally with `node app.js`
5. Commit your changes (`git commit -m 'Add amazing feature'`)
6. Push to the branch (`git push origin feature/amazing-feature`)
7. Open a Pull Request

## 📝 License

This project is open source and available under the [MIT License](LICENSE).

## 🙏 Acknowledgments

- **CCP Games** for providing the EVE Online ESI API
- **zKillboard** for hosting and maintaining this project
- **Squizz Caphinator** for the original concept and development
- **EVE Online Community** for the inspiration to track alliance logos

## 📞 Support

- **Issues**: Report bugs or request features via [GitHub Issues](https://github.com/zKillboard/logos.zzeve.com/issues)
- **EVE Online**: This project is not affiliated with CCP Games
- **zKillboard**: Visit [zkillboard.com](https://zkillboard.com) for EVE Online killboard data

---

*This project is a community tool for EVE Online players and is not affiliated with CCP Games.*
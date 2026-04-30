const {
    Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell,
    HeadingLevel, AlignmentType, BorderStyle, WidthType, ShadingType,
    LevelFormat, PageBreak, TableOfContents
  } = require('docx');
  const fs = require('fs');
  
  const border = { style: BorderStyle.SINGLE, size: 1, color: "DDDDDD" };
  const borders = { top: border, bottom: border, left: border, right: border };
  const noBorder = { style: BorderStyle.NONE, size: 0, color: "FFFFFF" };
  const noBorders = { top: noBorder, bottom: noBorder, left: noBorder, right: noBorder };
  
  const COLORS = {
    primary: "1E3A5F",
    accent: "2E86AB",
    green: "27AE60",
    orange: "E67E22",
    red: "E74C3C",
    lightBlue: "EBF5FB",
    lightGreen: "EAFAF1",
    lightGray: "F8F9FA",
    midGray: "95A5A6",
    dark: "2C3E50",
    white: "FFFFFF",
  };
  
  function h1(text) {
    return new Paragraph({
      heading: HeadingLevel.HEADING_1,
      spacing: { before: 400, after: 160 },
      children: [new TextRun({ text, bold: true, size: 36, color: COLORS.primary, font: "Arial" })]
    });
  }
  
  function h2(text) {
    return new Paragraph({
      heading: HeadingLevel.HEADING_2,
      spacing: { before: 320, after: 120 },
      children: [new TextRun({ text, bold: true, size: 28, color: COLORS.accent, font: "Arial" })]
    });
  }
  
  function h3(text) {
    return new Paragraph({
      heading: HeadingLevel.HEADING_3,
      spacing: { before: 200, after: 80 },
      children: [new TextRun({ text, bold: true, size: 24, color: COLORS.dark, font: "Arial" })]
    });
  }
  
  function p(text, opts = {}) {
    return new Paragraph({
      spacing: { before: 80, after: 80 },
      children: [new TextRun({ text, size: 22, font: "Arial", color: COLORS.dark, ...opts })]
    });
  }
  
  function bullet(text, level = 0) {
    return new Paragraph({
      numbering: { reference: "bullets", level },
      spacing: { before: 60, after: 60 },
      children: [new TextRun({ text, size: 22, font: "Arial", color: COLORS.dark })]
    });
  }
  
  function note(text, color = COLORS.lightBlue) {
    return new Table({
      width: { size: 9360, type: WidthType.DXA },
      columnWidths: [9360],
      rows: [new TableRow({ children: [new TableCell({
        borders: noBorders,
        width: { size: 9360, type: WidthType.DXA },
        shading: { fill: color, type: ShadingType.CLEAR },
        margins: { top: 120, bottom: 120, left: 200, right: 200 },
        children: [new Paragraph({
          children: [new TextRun({ text, size: 21, font: "Arial", color: COLORS.dark, italics: true })]
        })]
      })]})],
    });
  }
  
  function spacer() {
    return new Paragraph({ spacing: { before: 80, after: 80 }, children: [new TextRun("")] });
  }
  
  function pageBreak() {
    return new Paragraph({ children: [new PageBreak()] });
  }
  
  function tableHeader(cells) {
    return new TableRow({
      tableHeader: true,
      children: cells.map((text, i) => new TableCell({
        borders,
        width: { size: Math.floor(9360 / cells.length), type: WidthType.DXA },
        shading: { fill: COLORS.primary, type: ShadingType.CLEAR },
        margins: { top: 100, bottom: 100, left: 140, right: 140 },
        children: [new Paragraph({ children: [new TextRun({ text, bold: true, size: 20, color: COLORS.white, font: "Arial" })] })]
      }))
    });
  }
  
  function tableRow(cells, shade = false) {
    return new TableRow({
      children: cells.map(text => new TableCell({
        borders,
        width: { size: Math.floor(9360 / cells.length), type: WidthType.DXA },
        shading: { fill: shade ? COLORS.lightGray : COLORS.white, type: ShadingType.CLEAR },
        margins: { top: 80, bottom: 80, left: 140, right: 140 },
        children: [new Paragraph({ children: [new TextRun({ text, size: 20, font: "Arial", color: COLORS.dark })] })]
      }))
    });
  }
  
  function twoColRow(label, value, shade = false) {
    return new TableRow({
      children: [
        new TableCell({
          borders,
          width: { size: 3000, type: WidthType.DXA },
          shading: { fill: shade ? COLORS.lightGray : COLORS.white, type: ShadingType.CLEAR },
          margins: { top: 80, bottom: 80, left: 140, right: 140 },
          children: [new Paragraph({ children: [new TextRun({ text: label, bold: true, size: 20, font: "Arial", color: COLORS.dark })] })]
        }),
        new TableCell({
          borders,
          width: { size: 6360, type: WidthType.DXA },
          shading: { fill: shade ? COLORS.lightGray : COLORS.white, type: ShadingType.CLEAR },
          margins: { top: 80, bottom: 80, left: 140, right: 140 },
          children: [new Paragraph({ children: [new TextRun({ text: value, size: 20, font: "Arial", color: COLORS.dark })] })]
        }),
      ]
    });
  }
  
  // ─── COVER PAGE ──────────────────────────────────────────────────────────────
  const cover = [
    spacer(), spacer(), spacer(),
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { before: 0, after: 200 },
      children: [new TextRun({ text: "MARKET PULSE AI", bold: true, size: 72, color: COLORS.primary, font: "Arial" })]
    }),
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { before: 0, after: 120 },
      children: [new TextRun({ text: "Personal Indian Stock Market Intelligence System", size: 32, color: COLORS.accent, font: "Arial" })]
    }),
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { before: 0, after: 400 },
      border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: COLORS.accent, space: 1 } },
      children: [new TextRun({ text: "Full Product Specification  ·  NSE/BSE Feed Ingestion  ·  AI Analysis  ·  Daily Briefings", size: 22, color: COLORS.midGray, font: "Arial" })]
    }),
    spacer(),
    new Table({
      width: { size: 9360, type: WidthType.DXA },
      columnWidths: [4680, 4680],
      rows: [
        new TableRow({ children: [
          new TableCell({
            borders: noBorders,
            width: { size: 4680, type: WidthType.DXA },
            shading: { fill: COLORS.lightBlue, type: ShadingType.CLEAR },
            margins: { top: 200, bottom: 200, left: 200, right: 200 },
            children: [
              new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: "Stack", bold: true, size: 22, color: COLORS.primary, font: "Arial" })] }),
              new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: "TypeScript · Node.js · Cursor SDK", size: 20, font: "Arial", color: COLORS.dark })] }),
            ]
          }),
          new TableCell({
            borders: noBorders,
            width: { size: 4680, type: WidthType.DXA },
            shading: { fill: COLORS.lightGreen, type: ShadingType.CLEAR },
            margins: { top: 200, bottom: 200, left: 200, right: 200 },
            children: [
              new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: "Markets", bold: true, size: 22, color: COLORS.green, font: "Arial" })] }),
              new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: "NSE  ·  BSE  ·  SEBI Compliant", size: 20, font: "Arial", color: COLORS.dark })] }),
            ]
          }),
        ]})
      ]
    }),
    spacer(), spacer(), spacer(), spacer(),
    new Paragraph({
      alignment: AlignmentType.CENTER,
      children: [new TextRun({ text: "Version 1.0  ·  April 2026  ·  Personal Use — Not for Distribution", size: 18, color: COLORS.midGray, font: "Arial", italics: true })]
    }),
    pageBreak(),
  ];
  
  // ─── SECTION 1: OVERVIEW ─────────────────────────────────────────────────────
  const overview = [
    h1("1. Project Overview"),
    p("Market Pulse AI is a personal stock market intelligence system for Indian markets (NSE/BSE). It ingests real-time and end-of-day market data, enriches it with fundamental and sentiment signals, and delivers a daily AI-generated briefing every morning before market open. The system is built for a single developer-investor running it on their own machine using the Cursor SDK for agent orchestration."),
    spacer(),
    h2("1.1 Core Philosophy"),
    bullet("AI is a research assistant, not an autonomous trader — all orders are placed manually"),
    bullet("SEBI compliant by design — no algo order routing, no signal distribution to others"),
    bullet("Modular pipeline — each stage (ingest, enrich, analyse, brief) can be run independently"),
    bullet("Opinionated defaults — works out of the box with Zerodha Kite API + free data sources"),
    bullet("Backtesting first — every screen/signal must be backtested before watching live"),
    spacer(),
    h2("1.2 What It Delivers Daily"),
    p("Every morning at 7:30 AM IST (before 9:15 AM market open), the system emails/Slacks you a briefing containing:"),
    spacer(),
    new Table({
      width: { size: 9360, type: WidthType.DXA },
      columnWidths: [3200, 6160],
      rows: [
        tableHeader(["Briefing Section", "What It Contains"]),
        twoColRow("Market Mood", "Global cues (Dow, Nasdaq, SGX Nifty), FII/DII flows, VIX, Nifty/Sensex gaps", false),
        twoColRow("Watchlist Alerts", "Stocks on your watchlist that have triggered your custom criteria overnight", true),
        twoColRow("Earnings Digest", "Upcoming results this week + AI summary of last night's results", false),
        twoColRow("Top Movers", "Pre-market movers with volume context + likely reason (news/result/sector)", true),
        twoColRow("Sector Pulse", "Which sectors are seeing FII buying/selling, which are outperforming", false),
        twoColRow("AI Recommendations", "3-5 actionable ideas with thesis, entry zone, risk, and time horizon", true),
        twoColRow("Portfolio Check", "Your current holdings: any stop-loss breaches, rebalancing needs", false),
      ]
    }),
    spacer(),
    note("⚖️  SEBI Compliance: This system generates recommendations for your personal use only. All trade execution is manual via your broker's official interface. No automated order placement. No signal sharing. This keeps you fully outside the April 2026 SEBI Algo Trading framework."),
    pageBreak(),
  ];
  
  // ─── SECTION 2: ARCHITECTURE ─────────────────────────────────────────────────
  const architecture = [
    h1("2. System Architecture"),
    p("The system is a pipeline of four sequential stages, each implemented as a Cursor Agent task. Stages write their outputs to a local SQLite database, so any stage can be re-run independently."),
    spacer(),
    h2("2.1 High-Level Pipeline"),
    spacer(),
    new Table({
      width: { size: 9360, type: WidthType.DXA },
      columnWidths: [1800, 2200, 2600, 2760],
      rows: [
        tableHeader(["Stage", "Name", "Input", "Output"]),
        tableRow(["Stage 1", "Ingestor", "External APIs", "Raw market data → SQLite"], false),
        tableRow(["Stage 2", "Enricher", "Raw data + News", "Enriched signals → SQLite"], true),
        tableRow(["Stage 3", "Analyser", "Enriched signals", "Screener results + theses"], false),
        tableRow(["Stage 4", "Briefing Agent", "Analysis + Portfolio", "HTML email / Slack message"], true),
      ]
    }),
    spacer(),
    h2("2.2 Repository Structure"),
    spacer(),
    new Table({
      width: { size: 9360, type: WidthType.DXA },
      columnWidths: [3800, 5560],
      rows: [
        tableHeader(["Path", "Purpose"]),
        tableRow(["market-pulse-ai/", "Monorepo root"], false),
        tableRow(["  src/agents/", "Cursor Agent task definitions (.ts files)"], true),
        tableRow(["  src/ingestors/", "Data source connectors (Kite, NSE, news)"], false),
        tableRow(["  src/enrichers/", "Signal computation (technicals, fundamentals)"], true),
        tableRow(["  src/analysers/", "Screening logic + AI thesis generation"], false),
        tableRow(["  src/briefing/", "Daily briefing template + delivery"], true),
        tableRow(["  src/db/", "SQLite schema + query helpers"], false),
        tableRow(["  src/portfolio/", "Holdings tracker + P&L calculator"], true),
        tableRow(["  src/backtest/", "Strategy backtesting engine"], false),
        tableRow(["  config/", "Watchlists, screen rules, alert thresholds"], true),
        tableRow(["  scripts/", "Cron setup, manual run scripts"], false),
        tableRow(["  data/", "Local SQLite DB + historical data cache"], true),
      ]
    }),
    spacer(),
    h2("2.3 Technology Stack"),
    spacer(),
    new Table({
      width: { size: 9360, type: WidthType.DXA },
      columnWidths: [2400, 3200, 3760],
      rows: [
        tableHeader(["Layer", "Technology", "Reason"]),
        tableRow(["Agent Orchestration", "Cursor SDK (@cursor/sdk)", "Your existing subscription, local run"], false),
        tableRow(["Runtime", "Node.js 20 + TypeScript", "Cursor SDK native, strong typing"], true),
        tableRow(["Database", "SQLite (better-sqlite3)", "Zero infra, fast, portable"], false),
        tableRow(["Broker API", "Zerodha Kite Connect API", "Best Indian broker API, free tier"], true),
        tableRow(["Market Data (free)", "NSE India website scrape + Yahoo Finance", "Free, reliable for EOD"], false),
        tableRow(["Market Data (paid)", "Upstox API or Dhan API", "Real-time, ₹0 if you trade there"], true),
        tableRow(["News / Sentiment", "NewsAPI + RSS (ET, Moneycontrol)", "Free tier sufficient"], false),
        tableRow(["Fundamentals", "Screener.in scraper", "Free, comprehensive"], true),
        tableRow(["Scheduler", "node-cron", "Simple, no external deps"], false),
        tableRow(["Email Delivery", "Nodemailer + Gmail SMTP", "Free, zero config"], true),
        tableRow(["AI Model", "Claude Sonnet (via Cursor Agent)", "Reasoning + structured output"], false),
      ]
    }),
    pageBreak(),
  ];
  
  // ─── SECTION 3: DATA SOURCES ─────────────────────────────────────────────────
  const dataSources = [
    h1("3. Data Sources & Ingestor Specification"),
    spacer(),
    h2("3.1 Free Data Sources (Default Setup)"),
    p("The system is designed to work entirely on free data sources out of the box. Paid upgrades are optional for real-time data."),
    spacer(),
    new Table({
      width: { size: 9360, type: WidthType.DXA },
      columnWidths: [2200, 2400, 2400, 2360],
      rows: [
        tableHeader(["Source", "Data Type", "Frequency", "Access Method"]),
        tableRow(["NSE India (nseindia.com)", "OHLCV, F&O OI, FII/DII", "EOD + Intraday", "Public JSON endpoints"], false),
        tableRow(["BSE India (bseindia.com)", "OHLCV, corporate actions", "EOD", "Public endpoints"], true),
        tableRow(["Yahoo Finance", "OHLCV, adjusted prices", "EOD", "yfinance npm package"], false),
        tableRow(["Screener.in", "P/E, ROE, Revenue, Debt", "Weekly refresh", "HTML scraping"], true),
        tableRow(["Tickertape (free)", "Earnings calendar, estimates", "Weekly", "Public API"], false),
        tableRow(["Economic Times RSS", "News headlines + URLs", "Real-time", "RSS feed"], true),
        tableRow(["Moneycontrol RSS", "News + market updates", "Real-time", "RSS feed"], false),
        tableRow(["RBI / SEBI websites", "Policy, macro data", "As released", "PDF scraping"], true),
      ]
    }),
    spacer(),
    h2("3.2 Optional Paid Upgrades"),
    spacer(),
    new Table({
      width: { size: 9360, type: WidthType.DXA },
      columnWidths: [2200, 2800, 4360],
      rows: [
        tableHeader(["Source", "Cost", "What It Adds"]),
        tableRow(["Zerodha Kite Connect", "₹2000/month or free if you trade", "Real-time tick data, order book, portfolio sync"], false),
        tableRow(["Upstox API", "Free with Upstox account", "Real-time Level 1 quotes, historical 5-min OHLCV"], true),
        tableRow(["Dhan API", "Free with Dhan account", "Real-time, good for options data"], false),
        tableRow(["TrueData", "₹500–2000/month", "Professional tick data, 10+ years history"], true),
      ]
    }),
    spacer(),
    note("💡 Start with the free tier. NSE's public JSON endpoints (used by their website) give you everything you need for EOD analysis. Add Kite/Upstox only when you want intraday signals.", COLORS.lightGreen),
    spacer(),
    h2("3.3 Ingestor Interface Contract"),
    p("Every ingestor must implement the following TypeScript interface so the pipeline is modular and swappable:"),
    spacer(),
    new Table({
      width: { size: 9360, type: WidthType.DXA },
      columnWidths: [9360],
      rows: [new TableRow({ children: [new TableCell({
        borders,
        width: { size: 9360, type: WidthType.DXA },
        shading: { fill: "1E1E1E", type: ShadingType.CLEAR },
        margins: { top: 140, bottom: 140, left: 200, right: 200 },
        children: [
          new Paragraph({ children: [new TextRun({ text: "interface Ingestor {", font: "Courier New", size: 20, color: "9CDCFE" })] }),
          new Paragraph({ children: [new TextRun({ text: "  name: string;                        // 'nse-eod' | 'kite-tick' | ...", font: "Courier New", size: 20, color: "6A9955" })] }),
          new Paragraph({ children: [new TextRun({ text: "  fetch(symbols: string[]): Promise<RawQuote[]>;", font: "Courier New", size: 20, color: "DCDCAA" })] }),
          new Paragraph({ children: [new TextRun({ text: "  fetchFundamentals(symbol: string): Promise<Fundamentals>;", font: "Courier New", size: 20, color: "DCDCAA" })] }),
          new Paragraph({ children: [new TextRun({ text: "  fetchNews(symbol?: string): Promise<NewsItem[]>;", font: "Courier New", size: 20, color: "DCDCAA" })] }),
          new Paragraph({ children: [new TextRun({ text: "}", font: "Courier New", size: 20, color: "9CDCFE" })] }),
        ]
      })]})],
    }),
    spacer(),
    h2("3.4 Database Schema (SQLite)"),
    p("All ingested data is stored locally. Key tables:"),
    spacer(),
    new Table({
      width: { size: 9360, type: WidthType.DXA },
      columnWidths: [2400, 3400, 3560],
      rows: [
        tableHeader(["Table", "Key Columns", "Populated By"]),
        tableRow(["quotes", "symbol, date, open, high, low, close, volume", "NSE / Kite ingestor"], false),
        tableRow(["fundamentals", "symbol, pe, roe, revenue_growth, debt_equity, promoter_holding", "Screener ingestor"], true),
        tableRow(["news", "symbol, headline, source, url, sentiment_score, published_at", "News ingestor"], false),
        tableRow(["fii_dii", "date, fii_net, dii_net, segment (cash/fno)", "NSE ingestor"], true),
        tableRow(["signals", "symbol, date, signal_type, value, source_stage", "Enricher"], false),
        tableRow(["screens", "symbol, date, screen_name, score, thesis_json", "Analyser"], true),
        tableRow(["portfolio", "symbol, qty, avg_price, stop_loss, target, notes", "Manual / Kite sync"], false),
        tableRow(["briefings", "date, html_content, sent_at, delivery_method", "Briefing agent"], true),
      ]
    }),
    pageBreak(),
  ];
  
  // ─── SECTION 4: ENRICHER ─────────────────────────────────────────────────────
  const enricher = [
    h1("4. Enricher Specification"),
    p("The Enricher reads raw quotes and fundamentals from SQLite, computes signals, and writes them back. It runs after each ingest. All computations are pure TypeScript — no external API calls."),
    spacer(),
    h2("4.1 Technical Signals"),
    spacer(),
    new Table({
      width: { size: 9360, type: WidthType.DXA },
      columnWidths: [2600, 2400, 4360],
      rows: [
        tableHeader(["Signal", "Formula", "Usage"]),
        tableRow(["SMA 20 / 50 / 200", "Simple moving average", "Trend direction, golden/death cross"], false),
        tableRow(["EMA 9 / 21", "Exponential moving average", "Short-term momentum"], true),
        tableRow(["RSI (14)", "Wilder's RSI", "Overbought (>70) / oversold (<30) alerts"], false),
        tableRow(["ATR (14)", "Average True Range", "Stop-loss sizing, volatility filter"], true),
        tableRow(["VWAP", "Volume-weighted avg price", "Intraday bias indicator (if real-time data)"], false),
        tableRow(["Volume Ratio", "Today vol / 20-day avg vol", "Flag unusual volume (>2x = alert)"], true),
        tableRow(["52-week High/Low %", "Distance from 52W extremes", "Breakout detection, value screening"], false),
        tableRow(["PCR (Put-Call Ratio)", "Put OI / Call OI per strike", "Market sentiment for index/stocks"], true),
      ]
    }),
    spacer(),
    h2("4.2 Fundamental Signals"),
    spacer(),
    new Table({
      width: { size: 9360, type: WidthType.DXA },
      columnWidths: [2600, 6760],
      rows: [
        tableHeader(["Signal", "How It's Used"]),
        tableRow(["PEG Ratio", "P/E ÷ earnings growth — flag stocks where PEG < 1 as potentially undervalued"], false),
        tableRow(["Revenue Growth QoQ", "Flag accelerating growth (>20% YoY and growing each Q)"], true),
        tableRow(["Promoter Holding %", "Flag if promoter holding drops >2% quarter-on-quarter (red flag)"], false),
        tableRow(["FII/DII Net Activity", "Flag stocks with consistent FII buying over 3+ sessions"], true),
        tableRow(["Debt/Equity Ratio", "Filter out high-debt companies for long-term screens"], false),
        tableRow(["ROE Trend", "Flag companies with consistently improving ROE over 3 years"], true),
      ]
    }),
    spacer(),
    h2("4.3 Sentiment Signals"),
    bullet("News sentiment score per stock: computed by Claude on headline + first paragraph (positive/negative/neutral + confidence score)"),
    bullet("Sector sentiment roll-up: aggregate sentiment across all stocks in a sector"),
    bullet("Concall keyword detector: scan concall transcripts for words like 'headwinds', 'margin pressure', 'guidance cut' vs 'expansion', 'capacity addition', 'record'"),
    bullet("Social signal placeholder: reserved for future StockTwits / Reddit India integration"),
    pageBreak(),
  ];
  
  // ─── SECTION 5: ANALYSER & SCREENS ───────────────────────────────────────────
  const analyser = [
    h1("5. Analyser & Stock Screens"),
    p("The Analyser applies configurable screens to the enriched signal database. Each screen produces a scored shortlist. The Cursor Agent then generates a natural-language thesis for each stock that passes."),
    spacer(),
    h2("5.1 Built-in Screens"),
    spacer(),
    new Table({
      width: { size: 9360, type: WidthType.DXA },
      columnWidths: [2400, 3200, 3760],
      rows: [
        tableHeader(["Screen Name", "Criteria Summary", "Ideal For"]),
        tableRow(["Momentum Breakout", "52W high breakout + volume >2x + RSI 55-70 + positive FII", "Swing trades (2-6 weeks)"], false),
        tableRow(["Quality at Value", "ROE >15%, Revenue growth >20%, PE < sector avg, low debt", "Long-term (6-18 months)"], true),
        tableRow(["Earnings Surprise", "Beat estimates by >5%, revenue growth acceleration, guidance raise", "Post-results plays"], false),
        tableRow(["FII Accumulation", "FII net buying 3+ consecutive sessions, rising promoter stake", "Institutional following"], true),
        tableRow(["Oversold Reversal", "RSI <30, above 200 DMA, volume spike, positive news sentiment", "Mean reversion"], false),
        tableRow(["Small Cap Momentum", "Market cap <5000 cr, revenue growth >30%, price near 52W high", "High risk / high reward"], true),
        tableRow(["Dividend + Growth", "Dividend yield >3%, consistent payout history, EPS growth >15%", "Income + growth"], false),
      ]
    }),
    spacer(),
    note("🔧 All screens are defined as JSON in config/screens.json — fully customizable. Add, remove, or modify criteria without touching TypeScript code."),
    spacer(),
    h2("5.2 AI Thesis Generation (Cursor Agent)"),
    p("For each stock that passes a screen, the Cursor Agent receives the following context and generates a structured thesis:"),
    spacer(),
    h3("Agent Input"),
    bullet("Stock symbol, company name, sector, market cap"),
    bullet("Last 5 quarters of revenue, PAT, EPS with QoQ growth rates"),
    bullet("Technical position: current price vs SMA20/50/200, RSI, volume ratio"),
    bullet("Recent news headlines (last 7 days) with sentiment scores"),
    bullet("Screen criteria that triggered this recommendation"),
    bullet("Valuation: P/E, PEG, EV/EBITDA vs sector peers"),
    spacer(),
    h3("Agent Output (structured JSON)"),
    spacer(),
    new Table({
      width: { size: 9360, type: WidthType.DXA },
      columnWidths: [2800, 6560],
      rows: [
        tableHeader(["Output Field", "Description"]),
        tableRow(["thesis", "2-3 sentence plain English explanation of why this stock is interesting"], false),
        tableRow(["bullCase", "Top 2-3 reasons this could work"], true),
        tableRow(["bearCase", "Top 2 risks / reasons it could fail"], false),
        tableRow(["entryZone", "Suggested price range to enter (e.g. '₹485 – ₹510')"], true),
        tableRow(["stopLoss", "Suggested stop loss level with reasoning (e.g. 'below 200 DMA at ₹452')"], false),
        tableRow(["target", "12-month price target with basis"], true),
        tableRow(["timeHorizon", "short (1-4 weeks) / medium (1-6 months) / long (6-18 months)"], false),
        tableRow(["confidenceScore", "1-10 score based on signal strength + fundamental quality"], true),
        tableRow(["triggerScreen", "Which screen generated this idea"], false),
      ]
    }),
    pageBreak(),
  ];
  
  // ─── SECTION 6: BRIEFING AGENT ───────────────────────────────────────────────
  const briefing = [
    h1("6. Daily Briefing Agent"),
    spacer(),
    h2("6.1 Schedule & Trigger"),
    p("The briefing agent runs on a node-cron schedule. Recommended times:"),
    spacer(),
    new Table({
      width: { size: 9360, type: WidthType.DXA },
      columnWidths: [2400, 2600, 4360],
      rows: [
        tableHeader(["Job", "Cron Schedule", "What It Runs"]),
        tableRow(["Pre-market Briefing", "0 7 30 * * 1-5  (7:30 AM IST, weekdays)", "Full pipeline: ingest + enrich + analyse + brief"], false),
        tableRow(["Intraday Alert Check", "0 */30 9-15 * * 1-5  (every 30 min)", "Watchlist alert scan only (no AI, fast)"], true),
        tableRow(["EOD Summary", "30 15 * * 1-5  (3:30 PM IST)", "Portfolio P&L, what moved today, why"], false),
        tableRow(["Weekly Deep Dive", "0 8 * * 6  (8 AM Saturday)", "Full fundamental re-scan of watchlist"], true),
      ]
    }),
    spacer(),
    h2("6.2 Briefing Format"),
    p("The briefing is generated as a styled HTML email. Sections in order:"),
    bullet("Header: Date, Nifty/Sensex previous close, global overnight summary in 2 lines"),
    bullet("Market Mood Card: FII/DII net flows, India VIX, SGX Nifty gap, color-coded (green/red/yellow)"),
    bullet("Watchlist Alerts: Only stocks on your list that triggered a criteria — with the specific signal"),
    bullet("AI Picks (3-5): Card per stock with thesis, entry, stop, target, confidence score badge"),
    bullet("Upcoming Earnings This Week: Company, date, analyst estimates"),
    bullet("Sector Heat Map: Text-based, which sectors are hot/cold"),
    bullet("Portfolio Snapshot: Holdings table with current P&L, any breach of stop-loss levels"),
    bullet("Footer: Disclaimer reminder, links to raw data sources"),
    spacer(),
    h2("6.3 Delivery Options"),
    spacer(),
    new Table({
      width: { size: 9360, type: WidthType.DXA },
      columnWidths: [2200, 3200, 3960],
      rows: [
        tableHeader(["Method", "Setup Required", "Best For"]),
        tableRow(["Gmail (default)", "Nodemailer + App Password", "Rich HTML formatting, easiest to set up"], false),
        tableRow(["Slack DM", "Slack Webhook URL", "Quick scan on phone, markdown blocks"], true),
        tableRow(["WhatsApp", "Twilio WhatsApp API (free trial)", "Phone notifications with summary"], false),
        tableRow(["Telegram Bot", "BotFather token (free)", "Great mobile app, supports HTML"], true),
        tableRow(["Local HTML file", "None — just open in browser", "Best for desktop, full formatting"], false),
      ]
    }),
    pageBreak(),
  ];
  
  // ─── SECTION 7: CURSOR AGENT TASKS ───────────────────────────────────────────
  const cursorTasks = [
    h1("7. Cursor Agent Task Definitions"),
    p("These are the agent tasks you define using the Cursor SDK. Each maps to a file in src/agents/. Feed these specs to Cursor to generate the actual TypeScript implementation."),
    spacer(),
    h2("7.1 Agent: Daily Ingestor"),
    new Table({
      width: { size: 9360, type: WidthType.DXA },
      columnWidths: [2400, 6960],
      rows: [
        twoColRow("File", "src/agents/daily-ingestor.ts", false),
        twoColRow("Trigger", "Cron: 7:00 AM IST weekdays, or manual", true),
        twoColRow("Prompt", "Fetch today's pre-market data for all NSE 500 stocks. Get FII/DII from NSE. Get news from ET/Moneycontrol RSS. Store everything to SQLite. Log errors but don't fail the pipeline.", false),
        twoColRow("Tools Used", "NSE endpoints, Yahoo Finance, RSS parser, SQLite writer", true),
        twoColRow("Output", "Confirmation with row counts per table written", false),
      ]
    }),
    spacer(),
    h2("7.2 Agent: Signal Enricher"),
    new Table({
      width: { size: 9360, type: WidthType.DXA },
      columnWidths: [2400, 6960],
      rows: [
        twoColRow("File", "src/agents/signal-enricher.ts", false),
        twoColRow("Trigger", "Runs after Ingestor completes", true),
        twoColRow("Prompt", "Read all quotes from the last 200 days from SQLite. Compute SMA20, SMA50, SMA200, EMA9, RSI14, ATR14, Volume Ratio, 52W High/Low %. Score each fundamental metric. Write signals table.", false),
        twoColRow("Tools Used", "SQLite read/write only (pure computation)", true),
        twoColRow("Output", "signals table populated for all symbols", false),
      ]
    }),
    spacer(),
    h2("7.3 Agent: Stock Screener"),
    new Table({
      width: { size: 9360, type: WidthType.DXA },
      columnWidths: [2400, 6960],
      rows: [
        twoColRow("File", "src/agents/stock-screener.ts", false),
        twoColRow("Trigger", "Runs after Enricher completes", true),
        twoColRow("Prompt", "Load screen definitions from config/screens.json. Apply each screen's criteria against the signals table. For stocks passing any screen, call the thesis generator sub-agent. Write results to screens table.", false),
        twoColRow("Tools Used", "SQLite, Cursor sub-agent call for thesis generation", true),
        twoColRow("Output", "screens table with scored stocks and thesis JSON", false),
      ]
    }),
    spacer(),
    h2("7.4 Agent: Thesis Generator (Sub-agent)"),
    new Table({
      width: { size: 9360, type: WidthType.DXA },
      columnWidths: [2400, 6960],
      rows: [
        twoColRow("File", "src/agents/thesis-generator.ts", false),
        twoColRow("Trigger", "Called by Stock Screener per qualifying stock", true),
        twoColRow("Prompt", "Given the stock data JSON, generate a structured thesis as JSON with fields: thesis, bullCase, bearCase, entryZone, stopLoss, target, timeHorizon, confidenceScore. Be specific with price levels. Be honest about risks. Do not hype.", false),
        twoColRow("Model", "Claude Sonnet (via Cursor Agent)", true),
        twoColRow("Output", "thesis JSON object, written to screens table", false),
      ]
    }),
    spacer(),
    h2("7.5 Agent: Briefing Composer"),
    new Table({
      width: { size: 9360, type: WidthType.DXA },
      columnWidths: [2400, 6960],
      rows: [
        twoColRow("File", "src/agents/briefing-composer.ts", false),
        twoColRow("Trigger", "Runs after Screener, final step in pipeline", true),
        twoColRow("Prompt", "Read today's top screen results, FII/DII data, portfolio from SQLite. Compose a daily briefing in HTML. Include market mood header, top 5 stock picks with thesis cards, watchlist alerts, upcoming earnings. Be concise — total read time < 5 minutes.", false),
        twoColRow("Output", "HTML string → delivered via configured method (email/Slack/file)", true),
      ]
    }),
    pageBreak(),
  ];
  
  // ─── SECTION 8: BUILD PHASES ──────────────────────────────────────────────────
  const buildPhases = [
    h1("8. Build Phases & Milestones"),
    spacer(),
    h2("Phase 1 — Foundation (Week 1-2)"),
    note("Goal: Get data flowing and stored locally. No AI yet.", COLORS.lightGray),
    spacer(),
    bullet("Set up monorepo: TypeScript + ESM, better-sqlite3, node-cron"),
    bullet("Implement NSE EOD ingestor for Nifty 500 symbols"),
    bullet("Implement Screener.in fundamentals scraper for top 100 stocks"),
    bullet("Implement ET Markets + Moneycontrol RSS news ingestor"),
    bullet("Set up SQLite schema: quotes, fundamentals, news tables"),
    bullet("Write the Signal Enricher (pure TS, no API) with 8 technical signals"),
    bullet("Validation: query SQLite, verify data looks correct, plot a few charts"),
    spacer(),
    h2("Phase 2 — Screening (Week 3)"),
    note("Goal: Automated stock shortlisting without AI.", COLORS.lightGray),
    spacer(),
    bullet("Build screen engine: JSON-driven criteria evaluation"),
    bullet("Implement 3 screens: Momentum Breakout, Quality at Value, FII Accumulation"),
    bullet("Add watchlist config and alert system"),
    bullet("Build simple CLI: `npm run screen` outputs a console table of results"),
    bullet("Backtest: run screens against 6 months of historical data, evaluate results manually"),
    spacer(),
    h2("Phase 3 — AI Layer (Week 4)"),
    note("Goal: Add Cursor Agent for thesis generation and briefing composition.", COLORS.lightGray),
    spacer(),
    bullet("Integrate @cursor/sdk — thesis generator agent"),
    bullet("Test thesis quality: does it generate specific, non-generic output?"),
    bullet("Iterate on prompt until theses are consistently useful"),
    bullet("Build briefing composer agent → outputs local HTML file first"),
    bullet("Add sentiment analysis: news agent scores headlines per stock"),
    spacer(),
    h2("Phase 4 — Delivery & Polish (Week 5)"),
    note("Goal: Fully automated morning briefing delivered to your inbox.", COLORS.lightGray),
    spacer(),
    bullet("Wire up cron schedule (7:30 AM pipeline + 3:30 PM EOD)"),
    bullet("Set up Gmail delivery via Nodemailer"),
    bullet("Add portfolio tracker: manually enter holdings in config, system computes P&L"),
    bullet("Add stop-loss breach alerts (intraday check every 30 min if using real-time data)"),
    bullet("Week of paper trading: compare AI picks against actual market movement"),
    spacer(),
    h2("Phase 5 — Real Capital (Month 2+)"),
    note("⚠️ Only after Phase 4 paper trading shows consistently useful signals.", COLORS.lightBlue),
    spacer(),
    bullet("Connect Zerodha Kite API for real-time portfolio sync (replaces manual config)"),
    bullet("Enable real-time quote feed for watchlist stocks"),
    bullet("Add Kite webhook to trigger intraday alert checks on large price moves"),
    bullet("Add more screens based on what's been working in paper trading"),
    bullet("Optional: Telegram bot for push notifications"),
    pageBreak(),
  ];
  
  // ─── SECTION 9: SAMPLE PROMPTS FOR CURSOR ────────────────────────────────────
  const samplePrompts = [
    h1("9. Sample Prompts to Feed Cursor"),
    p("These are ready-to-paste prompts for your Cursor sessions. Each generates a complete, working module."),
    spacer(),
    h2("Prompt 1: NSE Ingestor"),
    new Table({
      width: { size: 9360, type: WidthType.DXA },
      columnWidths: [9360],
      rows: [new TableRow({ children: [new TableCell({
        borders,
        width: { size: 9360, type: WidthType.DXA },
        shading: { fill: COLORS.lightGray, type: ShadingType.CLEAR },
        margins: { top: 140, bottom: 140, left: 200, right: 200 },
        children: [
          new Paragraph({ children: [new TextRun({ text: 'Build src/ingestors/nse-eod.ts. It should:', font: "Arial", size: 20, color: COLORS.dark })] }),
          new Paragraph({ children: [new TextRun({ text: '1. Accept a string[] of NSE symbols', font: "Arial", size: 20, color: COLORS.dark })] }),
          new Paragraph({ children: [new TextRun({ text: "2. Fetch OHLCV data from NSE's public JSON endpoint (https://www.nseindia.com/api/quote-equity?symbol=RELIANCE)", font: "Arial", size: 20, color: COLORS.dark })] }),
          new Paragraph({ children: [new TextRun({ text: '3. Handle rate limiting (max 2 req/sec), retry on 429, skip on persistent failure', font: "Arial", size: 20, color: COLORS.dark })] }),
          new Paragraph({ children: [new TextRun({ text: '4. Upsert results into SQLite table "quotes" (symbol, date, open, high, low, close, volume)', font: "Arial", size: 20, color: COLORS.dark })] }),
          new Paragraph({ children: [new TextRun({ text: '5. Return { fetched: number, failed: string[] }', font: "Arial", size: 20, color: COLORS.dark })] }),
          new Paragraph({ children: [new TextRun({ text: 'Use better-sqlite3. Full TypeScript with types. No external state.', font: "Arial", size: 20, color: COLORS.dark })] }),
        ]
      })]})],
    }),
    spacer(),
    h2("Prompt 2: Technical Signal Enricher"),
    new Table({
      width: { size: 9360, type: WidthType.DXA },
      columnWidths: [9360],
      rows: [new TableRow({ children: [new TableCell({
        borders,
        width: { size: 9360, type: WidthType.DXA },
        shading: { fill: COLORS.lightGray, type: ShadingType.CLEAR },
        margins: { top: 140, bottom: 140, left: 200, right: 200 },
        children: [
          new Paragraph({ children: [new TextRun({ text: 'Build src/enrichers/technical.ts. Given a symbol, read its last 200 days of quotes from SQLite and compute:', font: "Arial", size: 20, color: COLORS.dark })] }),
          new Paragraph({ children: [new TextRun({ text: '- SMA 20, 50, 200 (simple moving average)', font: "Arial", size: 20, color: COLORS.dark })] }),
          new Paragraph({ children: [new TextRun({ text: '- EMA 9, 21 (exponential moving average)', font: "Arial", size: 20, color: COLORS.dark })] }),
          new Paragraph({ children: [new TextRun({ text: "- RSI 14 (Wilder's smoothing method)", font: "Arial", size: 20, color: COLORS.dark })] }),
          new Paragraph({ children: [new TextRun({ text: '- ATR 14 (average true range)', font: "Arial", size: 20, color: COLORS.dark })] }),
          new Paragraph({ children: [new TextRun({ text: '- Volume ratio vs 20-day average', font: "Arial", size: 20, color: COLORS.dark })] }),
          new Paragraph({ children: [new TextRun({ text: '- 52-week high/low and % distance from current price', font: "Arial", size: 20, color: COLORS.dark })] }),
          new Paragraph({ children: [new TextRun({ text: 'Write each signal as a row into the "signals" table. No external libraries for math — implement all formulas natively.', font: "Arial", size: 20, color: COLORS.dark })] }),
        ]
      })]})],
    }),
    spacer(),
    h2("Prompt 3: Screen Engine"),
    new Table({
      width: { size: 9360, type: WidthType.DXA },
      columnWidths: [9360],
      rows: [new TableRow({ children: [new TableCell({
        borders,
        width: { size: 9360, type: WidthType.DXA },
        shading: { fill: COLORS.lightGray, type: ShadingType.CLEAR },
        margins: { top: 140, bottom: 140, left: 200, right: 200 },
        children: [
          new Paragraph({ children: [new TextRun({ text: "Build src/analysers/screener.ts. Load screen definitions from config/screens.json. Each screen is: { name, description, criteria: [{ signal, operator, value }] }. Apply all criteria against today's signals table for all symbols. Return symbols that pass all criteria for a given screen, sorted by a composite score. Write results to 'screens' table with: symbol, date, screen_name, score, matched_criteria_json.", font: "Arial", size: 20, color: COLORS.dark })] }),
        ]
      })]})],
    }),
    spacer(),
    h2("Prompt 4: Thesis Generator Agent"),
    new Table({
      width: { size: 9360, type: WidthType.DXA },
      columnWidths: [9360],
      rows: [new TableRow({ children: [new TableCell({
        borders,
        width: { size: 9360, type: WidthType.DXA },
        shading: { fill: COLORS.lightGray, type: ShadingType.CLEAR },
        margins: { top: 140, bottom: 140, left: 200, right: 200 },
        children: [
          new Paragraph({ children: [new TextRun({ text: "Build src/agents/thesis-generator.ts using @cursor/sdk. For a given stock symbol + screen context JSON, construct a prompt that includes: last 5 quarters fundamentals, current technicals (RSI, SMA position, volume), recent news sentiment, screen criteria triggered. Send to Claude Sonnet. Parse the response as JSON: { thesis, bullCase: string[], bearCase: string[], entryZone, stopLoss, target, timeHorizon, confidenceScore }. Validate the JSON, retry once on parse failure. Write to screens table.", font: "Arial", size: 20, color: COLORS.dark })] }),
        ]
      })]})],
    }),
    pageBreak(),
  ];
  
  // ─── SECTION 10: RISK & DISCLAIMER ───────────────────────────────────────────
  const riskSection = [
    h1("10. Risk Management & Disclaimer"),
    spacer(),
    h2("10.1 Position Sizing Rules"),
    p("Hard-code these rules into the briefing agent so it always reminds you:"),
    bullet("No single stock >5% of total portfolio (for stocks in the first 6 months)"),
    bullet("No single sector >20% of portfolio"),
    bullet("Always size positions based on ATR stop: Risk per trade = 1% of portfolio value"),
    bullet("Formula: Position size = (Portfolio × 0.01) ÷ (Entry price − Stop loss price)"),
    bullet("Never increase a losing position — only add to winners that have moved in your favour"),
    spacer(),
    h2("10.2 System Limitations"),
    note("The AI thesis generator can produce plausible-sounding but incorrect analysis. Always verify key claims (especially price targets and financial figures) against primary sources like NSE filings or company investor relations pages before acting.", COLORS.lightBlue),
    spacer(),
    bullet("LLMs can hallucinate financial data — always cross-check thesis numbers against Screener.in"),
    bullet("Technical signals work until they don't — no indicator has >70% accuracy alone"),
    bullet("News sentiment is imperfect — sarcasm, context, and regional language nuances are missed"),
    bullet("Backtests are not forward tests — past screen performance does not guarantee future results"),
    bullet("This system does not account for liquidity — small-cap stocks may have wide bid-ask spreads"),
    spacer(),
    h2("10.3 Legal Reminder"),
    p("This system is built for personal research and investment decisions. It is not a SEBI-registered research analyst product. Do not share the briefings or AI recommendations with others. Do not automate order placement. All investment decisions and their consequences are your own responsibility."),
  ];
  
  // ─── ASSEMBLE DOCUMENT ────────────────────────────────────────────────────────
  const doc = new Document({
    styles: {
      default: {
        document: { run: { font: "Arial", size: 22, color: COLORS.dark } }
      },
      paragraphStyles: [
        { id: "Heading1", name: "Heading 1", basedOn: "Normal", next: "Normal", quickFormat: true,
          run: { size: 36, bold: true, font: "Arial", color: COLORS.primary },
          paragraph: { spacing: { before: 400, after: 160 }, outlineLevel: 0,
            border: { bottom: { style: BorderStyle.SINGLE, size: 4, color: COLORS.accent, space: 4 } } } },
        { id: "Heading2", name: "Heading 2", basedOn: "Normal", next: "Normal", quickFormat: true,
          run: { size: 28, bold: true, font: "Arial", color: COLORS.accent },
          paragraph: { spacing: { before: 320, after: 120 }, outlineLevel: 1 } },
        { id: "Heading3", name: "Heading 3", basedOn: "Normal", next: "Normal", quickFormat: true,
          run: { size: 24, bold: true, font: "Arial", color: COLORS.dark },
          paragraph: { spacing: { before: 200, after: 80 }, outlineLevel: 2 } },
      ]
    },
    numbering: {
      config: [
        { reference: "bullets",
          levels: [
            { level: 0, format: LevelFormat.BULLET, text: "•", alignment: AlignmentType.LEFT,
              style: { paragraph: { indent: { left: 720, hanging: 360 }, spacing: { before: 60, after: 60 } },
                run: { font: "Arial", size: 22, color: COLORS.dark } } },
            { level: 1, format: LevelFormat.BULLET, text: "◦", alignment: AlignmentType.LEFT,
              style: { paragraph: { indent: { left: 1080, hanging: 360 }, spacing: { before: 40, after: 40 } },
                run: { font: "Arial", size: 20, color: COLORS.midGray } } },
          ]
        }
      ]
    },
    sections: [{
      properties: {
        page: {
          size: { width: 12240, height: 15840 },
          margin: { top: 1440, right: 1296, bottom: 1440, left: 1296 }
        }
      },
      children: [
        ...cover,
        ...overview,
        ...architecture,
        ...dataSources,
        ...enricher,
        ...analyser,
        ...briefing,
        ...cursorTasks,
        ...buildPhases,
        ...samplePrompts,
        ...riskSection,
      ]
    }]
  });
  
  Packer.toBuffer(doc).then(buf => {
    const outPath = require('path').join(__dirname, 'market-pulse-ai-spec.docx');
    fs.writeFileSync(outPath, buf);
    console.log('Done ->', outPath);
  });
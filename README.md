# Expense Tracker

A simple expense manager built with plain HTML, CSS and JavaScript — no build step, no dependencies.

## Features

- **Add, edit and delete expenses** with an amount, category, date, payment method and note (deletes can be undone)
- **Month view:** step through months with ‹ › (or the ← → keys); click the month name to jump back to today
- **Summary cards:** total spent with change vs last month, budget left with a progress bar, daily average with a month-end projection, and your top category
- **Monthly budget** that warns at 80% and turns red when you go over
- **Charts:** spending by category (click a category to filter) and spending per day
- **Search, filter and sort** your transactions
- **Any currency, per expense:** pick the currency you actually paid in (160+ supported). Totals, charts and the budget are shown in your main currency, converted with daily exchange rates from [Exchange Rate API](https://www.exchangerate-api.com) (built-in approximate rates are used offline)
- **Your data stays in your browser.** Export to CSV, download a JSON backup and restore it on another device
- **Light and dark theme**, works on phones and desktops
- Press `n` to add an expense

## Run locally

Open `index.html` in your browser.

## Deploy

The site is static, so Vercel serves it as-is. Every push to `main` on GitHub redeploys it automatically.

const fs = require('fs');
const path = require('path');

const COMPANIES_PATH = './companies.json';
const HISTORY_PATH = './jobs-history.json';
const README_PATH = './README.md';

const CONCURRENCY_LIMIT = 10;

// API Detection Logic
function detectApi(company) {
  if (company.api && (company.api.includes('greenhouse') || company.api.includes('boards-api'))) {
    return { type: 'greenhouse', url: company.api };
  }

  const url = company.careers_url || '';

  // Ashby
  const ashbyMatch = url.match(/jobs\.ashbyhq\.com\/([^/?#]+)/);
  if (ashbyMatch) {
    return {
      type: 'ashby',
      url: `https://api.ashbyhq.com/posting-api/job-board/${ashbyMatch[1]}?includeCompensation=true`,
    };
  }

  // Lever
  const leverMatch = url.match(/jobs\.lever\.co\/([^/?#]+)/);
  if (leverMatch) {
    return {
      type: 'lever',
      url: `https://api.lever.co/v0/postings/${leverMatch[1]}`,
    };
  }

  // Greenhouse (handles boards.greenhouse.io and job-boards.greenhouse.io)
  const ghMatch = url.match(/boards(?:\.eu)?\.greenhouse\.io\/([^/?#]+)/) || url.match(/job-boards(?:\.eu)?\.greenhouse\.io\/([^/?#]+)/);
  if (ghMatch) {
    return {
      type: 'greenhouse',
      url: `https://boards-api.greenhouse.io/v1/boards/${ghMatch[1]}/jobs`,
    };
  }

  // SmartRecruiters
  const srMatch = url.match(/(?:careers|jobs)\.smartrecruiters\.com\/([^/?#]+)/);
  if (srMatch) {
    return {
      type: 'smartrecruiters',
      url: `https://api.smartrecruiters.com/v1/companies/${srMatch[1]}/postings?limit=100`,
    };
  }

  return null;
}

// API Parsers
function parseJobs(type, json, companyName) {
  if (type === 'greenhouse') {
    const jobs = json.jobs || [];
    return jobs.map(j => ({
      title: j.title || '',
      url: j.absolute_url || '',
      company: companyName,
      location: j.location?.name || 'Canada',
    }));
  }

  if (type === 'ashby') {
    const jobs = json.jobs || [];
    return jobs.map(j => {
      const locs = [j.location];
      if (j.secondaryLocations) {
        j.secondaryLocations.forEach(sl => {
          if (sl.location) locs.push(sl.location);
        });
      }
      return {
        title: j.title || '',
        url: j.jobUrl || '',
        company: companyName,
        location: locs.filter(Boolean).join(', '),
      };
    });
  }

  if (type === 'lever') {
    const jobs = Array.isArray(json) ? json : [];
    return jobs.map(j => ({
      title: j.text || '',
      url: j.hostedUrl || '',
      company: companyName,
      location: j.categories?.location || 'Canada',
    }));
  }

  if (type === 'smartrecruiters') {
    const jobs = json.content || [];
    return jobs.map(j => ({
      title: j.name || '',
      url: `https://jobs.smartrecruiters.com/${j.company.identifier}/${j.id}`,
      company: companyName,
      location: j.location ? `${j.location.city}, ${j.location.country}` : 'Canada',
    }));
  }

  return [];
}

// 2027 Canada Internship Filter
function is2027CanadaInternship(job) {
  const title = (job.title || '').toLowerCase();
  const location = (job.location || '').toLowerCase();

  // 1. Must be an internship or co-op
  const isIntern = /intern|co-?op|coop|student|fellow/i.test(title);
  if (!isIntern) return false;

  // 2. Location Check (Canada or Remote)
  const isCanada = /canada|toronto|waterloo|vancouver|montreal|ottawa|calgary|halifax|quebec|edmonton|winnipeg|remote/i.test(location);
  if (!isCanada) return false;

  // 3. Year/Term Check (Targeting 2027 internships, which will be posted starting mid-2026)
  const has2027 = title.includes('2027');
  const isWinter2027 = title.includes('winter') && !title.includes('2026') && !title.includes('2025');
  const isSummer2027 = title.includes('summer') && !title.includes('2026') && !title.includes('2025');
  const isFall2027 = title.includes('fall') && !title.includes('2026') && !title.includes('2025');

  return has2027 || isWinter2027 || isSummer2027 || isFall2027;
}

// Fetch helper with timeout
async function fetchWithTimeout(url, options = {}, timeout = 10000) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    clearTimeout(id);
    return response;
  } catch (error) {
    clearTimeout(id);
    throw error;
  }
}

// Concurrency queue
async function runConcurrent(tasks, limit) {
  const results = [];
  const executing = new Set();
  
  for (const task of tasks) {
    const p = Promise.resolve().then(() => task());
    results.push(p);
    executing.add(p);
    const clean = () => executing.delete(p);
    p.then(clean, clean);
    if (executing.size >= limit) {
      await Promise.race(executing);
    }
  }
  return Promise.all(results);
}

async function main() {
  try {
    console.log("Starting 2027 Canada Internship Scraper...");

    // Load companies
    if (!fs.existsSync(COMPANIES_PATH)) {
      throw new Error(`Companies list not found at ${COMPANIES_PATH}`);
    }
    const companies = JSON.parse(fs.readFileSync(COMPANIES_PATH, 'utf8')).filter(c => c.enabled);
    console.log(`Loaded ${companies.length} active companies.`);

    // Load history
    let history = [];
    if (fs.existsSync(HISTORY_PATH)) {
      history = JSON.parse(fs.readFileSync(HISTORY_PATH, 'utf8'));
    }
    console.log(`Loaded ${history.length} jobs from history.`);

    const activeJobs = [];
    const scannedCompanies = new Set();

    // Build scraping tasks
    const tasks = companies.map(company => async () => {
      const apiInfo = detectApi(company);
      if (!apiInfo) return;

      try {
        const res = await fetchWithTimeout(apiInfo.url, {}, 10000);
        if (!res.ok) {
          console.warn(`[WARN] Failed to fetch ${company.name}: HTTP ${res.status}`);
          return;
        }
        const json = await res.json();
        const parsed = parseJobs(apiInfo.type, json, company.name);
        const filtered = parsed.filter(is2027CanadaInternship);

        activeJobs.push(...filtered);
        scannedCompanies.add(company.name);
        console.log(`[SUCCESS] Scanned ${company.name} — found ${filtered.length} matching 2027 roles.`);
      } catch (err) {
        console.warn(`[ERROR] Scanning ${company.name} failed: ${err.message}`);
      }
    });

    // Run crawler
    await runConcurrent(tasks, CONCURRENCY_LIMIT);
    console.log(`Finished scanning. Found ${activeJobs.length} active matching jobs.`);

    // Merge with history
    const today = new Date().toISOString().split('T')[0];
    
    // Mark all previously active jobs from scanned companies as Closed if they are not in activeJobs
    history = history.map(job => {
      if (job.status === 'Active' && scannedCompanies.has(job.company)) {
        const isStillActive = activeJobs.some(active => 
          active.url === job.url || (active.company === job.company && active.title === job.title)
        );
        if (!isStillActive) {
          return { ...job, status: 'Closed' };
        }
      }
      return job;
    });

    // Add new active jobs to history
    activeJobs.forEach(active => {
      const exists = history.some(h => 
        h.url === active.url || (h.company === active.company && h.title === active.title)
      );
      if (!exists) {
        history.push({
          ...active,
          status: 'Active',
          date_added: today,
        });
      } else {
        // If it exists, make sure it's marked as Active
        history = history.map(h => {
          if (h.url === active.url || (h.company === active.company && h.title === active.title)) {
            return { ...h, status: 'Active' };
          }
          return h;
        });
      }
    });

    // Sort history (Active first, then by date added descending, then by company name)
    history.sort((a, b) => {
      if (a.status !== b.status) {
        return a.status === 'Active' ? -1 : 1;
      }
      if (a.date_added !== b.date_added) {
        return b.date_added.localeCompare(a.date_added);
      }
      return a.company.localeCompare(b.company);
    });

    // Save history
    fs.writeFileSync(HISTORY_PATH, JSON.stringify(history, null, 2));
    console.log(`Updated history file. Total records: ${history.length}`);

    // Generate README.md
    generateREADME(history, today);
    console.log("README.md generated successfully!");

  } catch (error) {
    console.error("Crawler failed:", error);
    process.exit(1);
  }
}

function generateREADME(jobs, dateStr) {
  const activeJobs = jobs.filter(j => j.status === 'Active');
  const closedJobs = jobs.filter(j => j.status === 'Closed');

  const activeTable = activeJobs.length > 0
    ? activeJobs.map(j => `| **${j.company}** | ${j.title} | \`${j.location}\` | 🟢 Active | [Apply ↗](${j.url}) | ${j.date_added} |`).join('\n')
    : '| - | *No active postings found yet. Scraper runs every 12 hours!* | - | - | - | - |';

  const closedTable = closedJobs.length > 0
    ? closedJobs.map(j => `| **${j.company}** | ${j.title} | \`${j.location}\` | 🔴 Closed | [Link ↗](${j.url}) | ${j.date_added} |`).join('\n')
    : '| - | *No closed postings yet.* | - | - | - | - |';

  const content = `# 🍁 2027 Canada Internships & Co-ops

Automated repository tracking Software Engineering, Data Science, Product, and AI/ML internships & co-ops in Canada for **2027** (Winter, Summer, Fall).

> 🤖 **Automated Tracker:** This list is updated automatically every 12 hours using GitHub Actions.
> 📅 **Last Scanned:** \`${dateStr}\`

---

## 📈 Active Postings (${activeJobs.length})

| Company | Role | Location | Status | Link | Date Added |
|---------|------|----------|--------|------|------------|
${activeTable}

---

## 🔒 Closed Postings (${closedJobs.length})

| Company | Role | Location | Status | Link | Date Added |
|---------|------|----------|--------|------|------------|
${closedTable}

---

## 🛠️ How it Works
This repository uses a zero-token scraper script ([crawl.js](./crawl.js)) that hits Greenhouse, Lever, Ashby, and SmartRecruiters APIs directly for **150+ Canadian employers**.

### Run locally
\`\`\`bash
npm install
node crawl.js
\`\`\`

---

## 🤝 Contributing
Want to add a company or a missing job board? 
1. Open a PR modifying [companies.json](./companies.json).
2. The GitHub action will automatically pick it up and scan it on the next run.

*Star the repository to stay updated! ⭐*
`;

  fs.writeFileSync(README_PATH, content);
}

main();

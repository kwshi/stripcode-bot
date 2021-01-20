import * as Fs from "fs";
import * as Rl from "readline-sync";
import Ppt from "puppeteer";
//import Axios from "axios";
import mkdirp from "mkdirp";
import * as Octo from "@octokit/rest";
import * as OctoTypes from "@octokit/types";

const getGhAuth = () => {
  return {
    username: process.env.GH_USERNAME ?? Rl.question("Enter GH username: "),
    password:
      process.env.GH_PASSWORD ??
      Rl.question("Enter GH password: ", { hideEchoBack: true }),
  };
};

interface Repo {
  id: string;
  owner: string;
  name: string;
  full: string;
}

const load = async () => {
  const browser = await Ppt.launch();
  const page = await browser.newPage();

  await Fs.promises
    .access("run/cookies.json")
    .then(async () => {
      const cookies = JSON.parse(
        await Fs.promises.readFile("run/cookies.json", "utf-8")
      );
      await page.setCookie(...cookies);
      await page.goto("https://stripcode.dev/ranked");

      const hostName = new URL(page.url()).hostname;
      if (hostName === "github.com") {
        await login(page);
      }
    })
    .catch(async () => {
      await page.goto("https://stripcode.dev/ranked");
      await login(page);
    });

  return { browser, page };
};

const login = async (page: Ppt.Page) => {
  const auth = getGhAuth();

  await page.type("form [name='login']", auth.username);
  await page.type("form [name='password']", auth.password);
  const click = page.click("form [type='submit']");
  const wait = page.waitForNavigation();

  await click;

  const otpCode = Rl.question("Enter 2FA code: ");

  await wait;

  await page.type("form [name='otp']", otpCode);
  await Promise.all([
    page.click("form [type='submit']"),
    page.waitForNavigation(),
  ]);

  const newCookies = await page.cookies();
  await mkdirp("run");
  await Fs.promises.writeFile(
    "run/cookies.json",
    JSON.stringify(newCookies, undefined, 2)
  );
};

const extract = async (page: Ppt.Page) => {
  await Promise.all([
    page.waitForSelector("div.text-lg"),
    page.waitForSelector("button[phx-value-githubrepoid]"),
    page.waitForSelector(".code-half > h1"),
    page.waitForSelector("#main-code-block"),
    page.waitForSelector(".code-half > div.text-lg"),
  ]);
  const [stats, repoIds, fileName, code, points] = await Promise.all([
    page.$$eval("div.text-lg", (els) => {
      const stats: Record<string, string> = {};
      els.map((el) => {
        const match = el.textContent
          ?.toLowerCase()
          .match(/(your total points|your rank|active users): #?([0-9]+)/i);
        if (!match) return undefined;
        const [, key, val] = match;
        stats[key] = val;
      });
      return stats;
    }),
    page.$$eval("[phx-value-githubrepoid]", (els) =>
      els.map((el) => el.getAttribute("phx-value-githubrepoid")!)
    ),
    page.$eval(".code-half h1", (el) => el.textContent),
    page.$eval("#main-code-block", (el) => el.textContent),
    page.$eval(".code-half div.text-lg", (el) =>
      parseInt(el.textContent ?? "", 10)
    ),
  ]);

  const longest = (code?.match(/[0-9A-Za-z_-]{1,128}/g) ?? [])
    .filter((a) => !a.toLowerCase().includes("redacted"))
    .reduce((a, b) => (b.length > a.length ? b : a))
    .trim();

  return {
    stats,
    fileName,
    longest,
    repoIds,
    points,
  };
};

//Axios.interceptors.request.use((x) => {
//  console.log(x);
//  return x;
//});

const round = async (page: Ppt.Page, octokit: Octo.Octokit) => {
  const info = await extract(page);
  console.log(info);

  // we don't use the repo names extracted from HTML since
  // they are sometimes inconsistent with the actual GH repo
  // names and so cause errors when we try to search on them.
  const repoResponses = await Promise.all(
    info.repoIds.map(
      (id) =>
        <Promise<OctoTypes.Endpoints["GET /repositories"]["response"]>>(
          octokit.request("/repositories/:id", { id })
        )
    )
  );

  const repos = repoResponses.flatMap((resp) => resp.data);

  const repoTerms = repos.map(
    (repo) => `repo:${JSON.stringify(repo.full_name)}`
  );

  const fileNameTerms = (info.fileName
    ? info.fileName.includes("redacted")
      ? repos.map(({ name }) => info.fileName!.replace("redacted", name))
      : [info.fileName]
    : []
  ).map((name) => `filename:${JSON.stringify(name)}`);

  const codeTerm = JSON.stringify(info.longest);

  const searchResp = await octokit.search.code({
    q: [...repoTerms, ...fileNameTerms, codeTerm].join(" "),
  });

  const scores = new Map<number, number>();
  for (const repo of repos) {
    scores.set(repo.id, 0);
  }
  for (const result of searchResp.data.items) {
    scores.set(
      result.repository.id,
      (scores.get(result.repository.id) ?? 0) + result.score
    );
  }

  const [best] = Array.from(
    scores.entries()
  ).reduce(([bestId, bestScore], [id, score]) =>
    score > bestScore ? [id, score] : [bestId, bestScore]
  );

  console.log(best);

  await Promise.all([
    page.click(`[phx-value-githubrepoid="${best}"]`),
    page.waitForSelector(".answer-half div.text-3xl.rounded"),
    page.waitForSelector("[phx-click='nextQuestion']"),
  ]);

  console.log(
    await page.$eval(".answer-half div.text-3xl.rounded", (el) =>
      el.textContent?.trim()
    )
  );

  console.log("solved, idling to comply with GH rate limiting...");
  await new Promise((resolve) => setTimeout(resolve, 500));

  await page.click("[phx-click='nextQuestion']");
  await new Promise((resolve) => setTimeout(resolve, 500));
};

const main = async () => {
  const { page } = await load();

  const octokit = new Octo.Octokit({
    userAgent: "kwshi-stripcode-bot",
    auth: process.env.GH_TOKEN!,
  });

  for (;;) {
    await round(page, octokit).catch((err) => console.log(err));
  }
};

main();

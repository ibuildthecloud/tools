import { Client } from "@notionhq/client";
import dotenv from "dotenv";
import path from "path";
import { PageObjectResponse } from "@notionhq/client/build/src/api-endpoints";
import { getPageContent } from "./page";

dotenv.config();

interface OutputMetadata {
  files: {
    [pageUrl: string]: {
      updatedAt: string;
      filePath: string;
      url: string;
      sizeInBytes: number;
    };
  };
  status: string;
  state: {
    notionState: {
      pages: Record<
        string,
        {
          title: string;
          folderPath: string;
          id: string;
        }
      >;
    };
  };
}

async function writePageToFile(
  client: Client,
  page: PageObjectResponse,
  gptscriptClient: any
): Promise<number> {
  const pageId = page.id;
  const pageContent = await getPageContent(client, pageId);
  const filePath = getPath(page);
  const buffer = Buffer.from(pageContent);
  await gptscriptClient.writeFileInWorkspace(filePath, buffer);
  return buffer.length;
}

function getPath(page: PageObjectResponse): string {
  const pageId = page.id;
  const fileDir = path.join(pageId.toString());
  let title = (
    (page.properties?.title ?? page.properties?.Name) as any
  )?.title[0]?.plain_text
    ?.trim()
    .replaceAll(/\//g, "-");
  if (!title) {
    title = pageId.toString();
  }
  return path.join(fileDir, title + ".md");
}

function getTitle(page: PageObjectResponse): string {
  let title = (
    (page.properties?.title ?? page.properties?.Name) as any
  )?.title[0]?.plain_text
    ?.trim()
    .replaceAll(/\//g, "-");
  if (!title) {
    title = page.id.toString();
  }
  return title;
}

async function getPage(client: Client, pageId: string) {
  const page = await client.pages.retrieve({ page_id: pageId });
  return page as PageObjectResponse;
}

async function main() {
  const client = new Client({
    auth: process.env.NOTION_TOKEN,
  });

  const gptscript = await import("@gptscript-ai/gptscript");
  const gptscriptClient = new gptscript.GPTScript();

  let output: OutputMetadata = {} as OutputMetadata;
  let metadataFile;
  try {
    metadataFile = await gptscriptClient.readFileInWorkspace(".metadata.json");
  } catch (err: any) {
    // Ignore any error if the metadata file doesn't exist. Ideally we should check for only not existing error but sdk doesn't provide that
  }
  if (metadataFile) {
    output = JSON.parse(metadataFile.toString());
  }

  if (!output.files) {
    output.files = {};
  }

  if (!output.state) {
    output.state = {} as {
      notionState: {
        pages: Record<
          string,
          { id: string; title: string; folderPath: string }
        >;
      };
    };
  }

  if (!output.state.notionState) {
    output.state.notionState = {} as {
      pages: Record<string, { id: string; title: string; folderPath: string }>;
    };
  }

  if (!output.state.notionState.pages) {
    output.state.notionState.pages = {};
  }

  let syncedCount = 0;
  const allPages = await client.search({
    filter: { property: "object", value: "page" },
  });

  const pageUrls = new Set();
  for (const page of allPages.results) {
    let p = page as PageObjectResponse;
    if (p.archived) {
      continue;
    }
    const pageId = p.id;
    const pageUrl = p.url;
    const pageTitle = getTitle(p);
    pageUrls.add(pageUrl);
    let folderPath = "";
    while (p.parent && p.parent.type === "page_id") {
      try {
        const parentPage = await getPage(client, p.parent.page_id);
        const parentTitle = getTitle(parentPage);
        folderPath = path.join(parentTitle, folderPath);
        p = parentPage;
      } catch (err: any) {
        folderPath = "";
        break;
      }
    }
    output.state.notionState.pages[pageUrl] = {
      id: pageId,
      title: pageTitle,
      folderPath: folderPath,
    };
  }

  await gptscriptClient.writeFileInWorkspace(
    ".metadata.json",
    Buffer.from(JSON.stringify(output, null, 2))
  );

  for (const pageUrl of Object.keys(output.state.notionState.pages)) {
    if (
      !allPages.results
        .filter((p) => !(p as PageObjectResponse).archived)
        .some((page) => (page as PageObjectResponse).url === pageUrl)
    ) {
      delete output.state.notionState.pages[pageUrl];
    }
  }

  for (const [pageUrl, pageDetails] of Object.entries(
    output.state.notionState.pages
  )) {
    const page = await getPage(client, pageDetails.id);
    if (
      !output.files[pageUrl] ||
      output.files[page.url].updatedAt !== page.last_edited_time
    ) {
      console.error(`Writing page url: ${page.url}`);
      const sizeInBytes = await writePageToFile(client, page, gptscriptClient);
      output.files[page.url] = {
        url: page.url,
        filePath: getPath(page!),
        updatedAt: page.last_edited_time,
        sizeInBytes: sizeInBytes,
      };
    } else {
      console.error(`Skipping page url: ${page.url}`);
    }
    syncedCount++;
    output.status = `${syncedCount}/${
      Object.keys(output.state.notionState.pages).length
    } number of pages have been synced`;
    await gptscriptClient.writeFileInWorkspace(
      ".metadata.json",
      Buffer.from(JSON.stringify(output, null, 2))
    );
  }
  for (const [pageUrl, fileInfo] of Object.entries(output.files)) {
    if (!pageUrls.has(pageUrl)) {
      try {
        await gptscriptClient.deleteFileInWorkspace(fileInfo.filePath);
        delete output.files[pageUrl];
        console.error(`Deleted file and entry for page URL: ${pageUrl}`);
      } catch (error) {
        console.error(`Failed to delete file ${fileInfo.filePath}:`, error);
      }
    }
  }

  output.status = "";
  await gptscriptClient.writeFileInWorkspace(
    ".metadata.json",
    Buffer.from(JSON.stringify(output, null, 2))
  );
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.log(JSON.stringify({ error: err.message }));
    process.exit(0);
  });

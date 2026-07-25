"use strict";

/**
 * Save Learning Engine State to GitHub
 * -----------------------------------------------------------------------
 * Runs through GitHub Actions.
 *
 * Responsibilities:
 * - Read learning-export.json.
 * - Validate the exported learning data.
 * - Read the current GitHub file SHA when it exists.
 * - Create or update data/learning-engine-state.json.
 * - Preserve the existing GitHub Contents API integration.
 * -----------------------------------------------------------------------
 */

const https = require("https");
const fs = require("fs");
const path = require("path");

const CONFIG = Object.freeze({
  githubToken:
    process.env.GITHUB_TOKEN || "",

  githubOwner:
    "7tpzbnydgg-commits",

  githubRepo:
    "pipsight-worker",

  githubBranch:
    "main",

  githubFilePath:
    "data/learning-engine-state.json",

  localExportPath:
    path.join(
      __dirname,
      "learning-export.json"
    ),

  requestTimeoutMs:
    20000,

  maxResponseBytes:
    5 * 1024 * 1024
});

class GitHubApiError extends Error {

  constructor(
    message,
    {
      statusCode = null,
      responseBody = null,
      method = null,
      requestPath = null
    } = {}
  ) {

    super(message);

    this.name =
      "GitHubApiError";

    this.statusCode =
      statusCode;

    this.responseBody =
      responseBody;

    this.method =
      method;

    this.requestPath =
      requestPath;

  }

}

function validateConfiguration() {

  if (
    !CONFIG.githubToken.trim()
  ) {

    throw new Error(
      "GITHUB_TOKEN is not configured."
    );

  }

  if (
    !CONFIG.githubOwner ||
    !CONFIG.githubRepo ||
    !CONFIG.githubFilePath ||
    !CONFIG.githubBranch
  ) {

    throw new Error(
      "GitHub repository configuration is incomplete."
    );

  }

}

function buildGitHubApiPath(
  filePath
) {

  const encodedPath =
    String(filePath)
      .split("/")
      .map(segment =>
        encodeURIComponent(segment)
      )
      .join("/");

  return (
    `/repos/` +
    `${encodeURIComponent(CONFIG.githubOwner)}/` +
    `${encodeURIComponent(CONFIG.githubRepo)}/` +
    `contents/${encodedPath}`
  );

}

function parseJsonResponse(
  body,
  context
) {

  const normalizedBody =
    String(body || "").trim();

  if (!normalizedBody) {

    return {};

  }

  try {

    return JSON.parse(
      normalizedBody
    );

  } catch (error) {

    throw new GitHubApiError(
      `GitHub API returned invalid JSON for ${context.method} ${context.requestPath}.`,
      {
        statusCode:
          context.statusCode,

        responseBody:
          normalizedBody,

        method:
          context.method,

        requestPath:
          context.requestPath
      }
    );

  }

}

function makeGitHubRequest(
  method,
  filePath,
  data = null
) {

  return new Promise(
    (resolve, reject) => {

      const requestPath =
        buildGitHubApiPath(
          filePath
        );

      const payload =
        data === null
          ? null
          : JSON.stringify(data);

      const headers = {
        Authorization:
          `Bearer ${CONFIG.githubToken}`,

        Accept:
          "application/vnd.github+json",

        "X-GitHub-Api-Version":
          "2022-11-28",

        "User-Agent":
          "PipSight-Learner",

        "Content-Type":
          "application/json"
      };

      if (payload !== null) {

        headers["Content-Length"] =
          Buffer.byteLength(payload);

      }

      const options = {
        hostname:
          "api.github.com",

        port:
          443,

        path:
          requestPath,

        method,

        headers
      };

      const request =
        https.request(
          options,
          response => {

            let body = "";

            let responseBytes = 0;

            response.setEncoding(
              "utf8"
            );

            response.on(
              "data",
              chunk => {

                responseBytes +=
                  Buffer.byteLength(
                    chunk
                  );

                if (
                  responseBytes >
                  CONFIG.maxResponseBytes
                ) {

                  request.destroy(
                    new Error(
                      "GitHub API response exceeded the allowed size."
                    )
                  );

                  return;

                }

                body += chunk;

              }
            );

            response.on(
              "end",
              () => {

                const statusCode =
                  response.statusCode || 0;

                let parsedBody;

                try {

                  parsedBody =
                    parseJsonResponse(
                      body,
                      {
                        method,
                        requestPath,
                        statusCode
                      }
                    );

                } catch (error) {

                  reject(error);
                  return;

                }

                if (
                  statusCode >= 200 &&
                  statusCode < 300
                ) {

                  resolve(
                    parsedBody
                  );

                  return;

                }

                const apiMessage =
                  parsedBody?.message
                    ? `: ${parsedBody.message}`
                    : "";

                reject(
                  new GitHubApiError(
                    `GitHub API ${statusCode}${apiMessage}`,
                    {
                      statusCode,
                      responseBody:
                        parsedBody,
                      method,
                      requestPath
                    }
                  )
                );

              }
            );

          }
        );

      request.setTimeout(
        CONFIG.requestTimeoutMs,
        () => {

          request.destroy(
            new Error(
              `GitHub API request timed out after ${CONFIG.requestTimeoutMs}ms.`
            )
          );

        }
      );

      request.on(
        "error",
        reject
      );

      if (payload !== null) {

        request.write(
          payload
        );

      }

      request.end();

    }
  );

}

async function getGitHubFile() {

  try {

    return await makeGitHubRequest(
      "GET",
      CONFIG.githubFilePath
    );

  } catch (error) {

    if (
      error instanceof GitHubApiError &&
      error.statusCode === 404
    ) {

      console.log(
        "Learning state file does not exist yet; a new file will be created."
      );

      return null;

    }

    throw error;

  }

}

function validateLearningData(
  learningData
) {

  if (
    !learningData ||
    typeof learningData !== "object" ||
    Array.isArray(learningData)
  ) {

    throw new Error(
      "Learning export must contain a JSON object."
    );

  }

  if (
    !learningData.learning ||
    typeof learningData.learning !==
      "object" ||
    Array.isArray(
      learningData.learning
    )
  ) {

    throw new Error(
      "Learning export is missing the learning object."
    );

  }

  if (
    !Array.isArray(
      learningData.learning.signals
    )
  ) {

    throw new Error(
      "Learning export is missing learning.signals array."
    );

  }

  return learningData;

}

function readLearningExport() {

  if (
    !fs.existsSync(
      CONFIG.localExportPath
    )
  ) {

    return null;

  }

  const rawContent =
    fs.readFileSync(
      CONFIG.localExportPath,
      "utf8"
    );

  if (
    !rawContent.trim()
  ) {

    throw new Error(
      "learning-export.json is empty."
    );

  }

  let parsed;

  try {

    parsed =
      JSON.parse(
        rawContent
      );

  } catch (error) {

    throw new Error(
      `learning-export.json contains invalid JSON: ${error.message}`
    );

  }

  return validateLearningData(
    parsed
  );

}

async function saveLearningStateToGitHub(
  learningData
) {

  console.log(
    "Fetching current GitHub learning state..."
  );

  const currentFile =
    await getGitHubFile();

  const currentSha =
    currentFile?.sha || null;

  const content =
    Buffer.from(
      JSON.stringify(
        learningData,
        null,
        2
      ),
      "utf8"
    ).toString(
      "base64"
    );

  const commitData = {
    message:
      `[Auto] Update learning engine state - ` +
      new Date().toISOString(),

    content,

    branch:
      CONFIG.githubBranch
  };

  if (currentSha) {

    commitData.sha =
      currentSha;

  }

  await makeGitHubRequest(
    "PUT",
    CONFIG.githubFilePath,
    commitData
  );

  console.log(
    "Learning state saved to GitHub successfully."
  );

  return true;

}

async function main() {

  validateConfiguration();

  const learningData =
    readLearningExport();

  if (!learningData) {

    console.log(
      "No learning export file found. Browser needs to trigger export first."
    );

    return {
      skipped: true,
      reason:
        "learning-export.json not found"
    };

  }

  const signalCount =
    learningData.learning.signals.length;

  console.log(
    `Read ${signalCount} signals from local export.`
  );

  await saveLearningStateToGitHub(
    learningData
  );

  return {
    skipped: false,
    saved: true,
    signalCount
  };

}

function logFatalError(
  error
) {

  console.error(
    "Fatal learning-state save error:"
  );

  console.error(
    error?.stack ||
    error?.message ||
    error
  );

  process.exitCode = 1;

}

if (
  require.main === module
) {

  main().catch(
    logFatalError
  );

}

module.exports = {
  CONFIG,
  GitHubApiError,
  buildGitHubApiPath,
  parseJsonResponse,
  makeGitHubRequest,
  getGitHubFile,
  validateLearningData,
  readLearningExport,
  saveLearningStateToGitHub,
  validateConfiguration,
  main
};

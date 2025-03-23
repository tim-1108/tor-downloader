import axios, { type AxiosProgressEvent, type AxiosRequestConfig, type AxiosResponse } from "axios";
import { SocksProxyAgent } from "socks-proxy-agent";
import readline from "node:readline/promises";
import { createWriteStream } from "node:fs";
import { stat, truncate, open } from "node:fs/promises";
import { type Readable } from "node:stream";

const proxy = "socks5h://localhost:9050";
const agent = new SocksProxyAgent(proxy);
const MAX_RETRY_COUNT = 100;
const RETRY_DELAY_MS = 3000;

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

const axiosOptions: AxiosRequestConfig = {
    httpAgent: agent,
    httpsAgent: agent,
    proxy: false
};

const client = axios.create(axiosOptions);

function sleep(ms: number) {
    return new Promise((resolve) => setTimeout(() => resolve(null), ms));
}

const FILE_SIZE_IDENTIFIERS = ["TB", "GB", "MB", "KB", "B"];
const FILE_MULTIPLIER = 1024;
function parseFileSize(size: number) {
    for (let i = FILE_SIZE_IDENTIFIERS.length - 1; i >= 0; i--) {
        const divider = Math.pow(FILE_MULTIPLIER, FILE_SIZE_IDENTIFIERS.length - i - 1);
        if (size / divider > FILE_MULTIPLIER) continue;
        return (size / divider).toFixed(1) + FILE_SIZE_IDENTIFIERS[i];
    }
}

async function getOutboundIP(useTorClient: boolean) {
    const response = await (useTorClient ? client : axios).get("https://httpbin.org/ip");
    return response.data?.origin ?? null;
}

const isThisYourIP = await rl.question(`Are these two IPs the same: ${await getOutboundIP(false)} | ${await getOutboundIP(true)} (y/n): `);
if (isThisYourIP.toLowerCase().startsWith("y")) {
    console.error("Aborting - Tor is not working!");
    process.exit(1);
}

console.log("Great - Tor is working!");
console.log("When entering backslashes, they should be escaped properly");
// If the user enters something stupid, it is their machine
const outputFileName = await rl.question("Please enter a valid path/filename to write the output to: ");

const targetAddressUnvalidated = await rl.question("Enter your target address: ");
// Throws an error if invalid
const url = new URL(targetAddressUnvalidated);

const contentLength = await getContentLengthIfRangesSupported(url.toString());

const type = await rl.question("Select type: [1: new request; 2: start at offset; 3: auto-offset] ");

// If the user starts anew, we require them to delete the existing output file
if (type !== "3") {
    try {
        const stats = await stat(outputFileName);
        if (stats.size > 0) {
            console.warn("Please remove or rename the current output file - it would be overwritten otherwise");
            process.exit(1);
        }
    } catch {}

    // First, we make sure the "output" file actually exists
    // If not, we cannot create a append write stream for it.
    const fileHandle = await open(outputFileName, "w");
    fileHandle.close();
}
if (type === "1") {
    startRequest(0);
} else if (type === "2") {
    startRequest(await askForRequestOffset());
} else if (type === "3") {
    try {
        const stats = await stat(outputFileName);
        console.log(`Will auto-offset at ${formatNumber(stats.size)} bytes`);
        startRequest(stats.size);
    } catch {
        console.warn("Cannot auto-detect the current file size as it does not exist - defaulting to 0");
        startRequest(0);
    }
}

async function askForRequestOffset() {
    const offsetString = await rl.question("Enter offset in bytes: ");
    const offset = parseIntWrapper(offsetString);
    if (isNaN(offset) || offset <= 0) {
        console.warn("No offset given!");
        return 0;
    }
    return offset;
}

async function startRequest(offset: number = 0) {
    const actualSize = contentLength - offset;
    const formattedContentLength = parseFileSize(actualSize);
    const desiredChunkCount = parseIntWrapper(
        await rl.question(`The content size is ${formattedContentLength} (${formatNumber(actualSize)}). How many chunks should be used: `)
    );

    const chunkSize = Math.floor(actualSize / desiredChunkCount);
    const remainder = actualSize - chunkSize * desiredChunkCount;
    console.log(
        `Chunk size: ${parseFileSize(chunkSize)} (${formatNumber(chunkSize)}); remainder: ${parseFileSize(remainder)} (${formatNumber(remainder)}) => is correct: ${chunkSize * desiredChunkCount + remainder === actualSize}`
    );
    await sleep(3000);

    for (let i = 0; i < desiredChunkCount; i++) {
        const offset = i * chunkSize;
        const hasSucceeded = await downloadChunkRetryWrapper({
            index: i,
            offset,
            size: chunkSize,
            totalSize: actualSize,
            chunkCount: desiredChunkCount
        });
        if (!hasSucceeded) {
            console.error(`Failed to download chunk ${i} - so at offset ${offset}, please restart at that offset!`);
            return;
        }
    }

    if (remainder === 0) return;
    const remainderOffset = chunkSize * desiredChunkCount;
    const hasSucceeded = await downloadChunkRetryWrapper({
        index: -1,
        offset: remainderOffset,
        size: remainder,
        totalSize: actualSize,
        chunkCount: desiredChunkCount
    });
    if (!hasSucceeded) {
        logToFile("Failed to download remainder of size", remainder, "- so at offset", remainderOffset);
        return;
    }

    console.info("Everything has been downloaded! Nice :)");
}

interface ChunkConfig {
    index: number;
    offset: number;
    size: number;
    chunkCount: number;
    totalSize: number;
}

async function downloadChunkRetryWrapper(config: ChunkConfig, retryCount: number = 0) {
    const result = await downloadChunk(config);
    if (result) return true;
    if (retryCount >= MAX_RETRY_COUNT) return false;
    console.log(`${useFormattedTimestamp()} Retrying chunk ${config.index} for the ${retryCount}th time`);
    await sleep(RETRY_DELAY_MS);
    return downloadChunkRetryWrapper(config, ++retryCount);
}

function parseContentLengthHeader(response: AxiosResponse): number {
    const header = response.headers["content-length"];
    if (!header) return NaN;
    if (typeof header === "number" && Number.isSafeInteger(header) && header >= 0) return header;

    if (typeof header === "string") {
        const asInt = parseInt(header, 10);
        return !isNaN(asInt) && Number.isSafeInteger(asInt) && asInt >= 0 ? asInt : NaN;
    }

    // If there are multiple headers (so this field is an array), we will not parse it
    return NaN;
}

function downloadChunk(config: ChunkConfig) {
    return new Promise<boolean>(async (resolve) => {
        const fileStat = await stat(outputFileName);
        const previousFileSize = fileStat.size;
        // If the downloading of a chunk is retried, this purely cosmetic indicator will be incorrect
        // Thus, we correct it here at this point.
        alreadyDownloadedBytes = previousFileSize;
        const writeStream = createWriteStream(outputFileName, { flags: "a" });
        let response: AxiosResponse;
        try {
            response = await client.get(url.toString(), {
                headers: {
                    Range: `bytes=${config.offset}-${config.offset + config.size - 1}`
                },
                onDownloadProgress: (event) => logDownloadSpeed(event, config),
                responseType: "stream"
            });
        } catch (error) {
            writeStream.close();
            resolve(false);
            return;
        }

        const reportedContentLength = parseContentLengthHeader(response);
        // This will also hit on NaN
        if (reportedContentLength !== config.size) {
            console.warn("Mismatch between content-length and desired size on chunk", config.index, ":", config.size, reportedContentLength);
            writeStream.close();
            await truncate(outputFileName, previousFileSize);
            resolve(false);
            return;
        }

        const stream = response.data as Readable;
        stream.pipe(writeStream);

        stream.on("error", async (error) => {
            logToFile(`Error in data stream for chunk ${config.index}: ${error.message} ${error.cause}`);
            await truncate(outputFileName, previousFileSize);
            writeStream.close(() => {
                resolve(false);
            });
        });

        stream.once("end", () => {
            // The write stream does not need to be closed manually
            resolve(true);
        });
    });
}

let alreadyDownloadedBytes = 0;
function logDownloadSpeed(event: AxiosProgressEvent, config: ChunkConfig) {
    if (!event.lengthComputable || !event.total || !event.download) return;

    // When a chunk is retried, this will be incorrect. However, this is useless and just a visual thing.
    alreadyDownloadedBytes += event.bytes;

    console.clear();
    const timestamp = useFormattedTimestamp();
    const totalRemainder = config.totalSize - alreadyDownloadedBytes;
    const secondsUntilFinish = event.rate ? Math.floor(totalRemainder / event.rate) : null;
    console.log(
        `${timestamp} Chunk ${config.index + 1}/${config.chunkCount}: ` +
            `${((event.progress ?? 0) * 100).toFixed(3)}% ` +
            `(${formatNumber(event.loaded)}/${formatNumber(event.total)})`
    );
    console.log(`${timestamp} Download Speed: ${parseFileSize(event.rate ?? 0)}/s`);
    console.log(`${timestamp} ETA chunk: ${event.estimated?.toFixed(3)} seconds`);
    console.log(
        `${timestamp} Total downloaded: ${((alreadyDownloadedBytes / config.totalSize) * 100).toFixed(3)}% ` +
            `${parseFileSize(alreadyDownloadedBytes)} ` +
            `(${formatNumber(alreadyDownloadedBytes)}/${formatNumber(config.totalSize)})`
    );
    if (secondsUntilFinish) {
        console.log(`${timestamp} ETA total: ${calculateDateDistance(Date.now(), Date.now() + secondsUntilFinish * 1000)}`);
    }
}

async function getContentLengthIfRangesSupported(target: string) {
    const response = await client.head(target);
    if (!response.headers || response.headers["accept-ranges"] !== "bytes") {
        console.error("Target does not support ranged requests");
        process.exit(1);
    }

    const clHeader = response.headers["content-length"] || "";
    if (typeof clHeader === "boolean" || typeof clHeader === "object") {
        console.error("Cannot handle this content-length header:", clHeader);
        process.exit(1);
    }
    const contentLength = typeof clHeader === "string" ? parseInt(clHeader) : clHeader;
    if (isNaN(contentLength) || !Number.isSafeInteger(contentLength) || contentLength <= 0) {
        console.error("Cannot handle this content-length:", contentLength);
        process.exit(1);
    }

    return contentLength;
}

function useFormattedTimestamp() {
    const date = new Date(Date.now());
    return `[${fillOutNumber(date.getHours())}:${fillOutNumber(date.getMinutes())}:${fillOutNumber(date.getSeconds())}]`;
}

function fillOutNumber(num: Number) {
    return num.toString(10).padStart(2, "0");
}

function calculateDateDistance(msTimestampA: number, msTimestampB: number) {
    const steps = [1000, 60, 60, 24];
    // It shouldn't matter whether it's in the future or past
    const difference = Math.abs(msTimestampA - msTimestampB);
    let iterator = 0;
    for (const step of ["second", "minute", "hour"]) {
        // This multiplies all steps before and including this current one
        // -> Refers to second, minute and hour
        const multiplier = steps.slice(0, iterator + 1).reduce((acc, value) => acc * value, 1);
        if (difference < multiplier * steps[iterator + 1]) {
            const number = Math.floor(difference / multiplier);
            return `${number} ${step}${number !== 1 ? "s" : ""}`;
        }
        iterator++;
    }
    // This is just a fallback if the thing has not been reloaded within the
    // last 24 hours (like on weekends) -> there shouldn't be 100 hours on the counter
    const days = Math.floor(difference / (1000 * 60 * 60 * 24));
    return `${days} day(s)`;
}

const logFileHandle = createWriteStream("download.log", { flags: "a" });
function logToFile(...args: (string | number | symbol | boolean | null | undefined)[]) {
    logFileHandle.write(`${useFormattedTimestamp()} ${args.join(" ")}\n`);
}

/**
 * Replaces separator characters which a user might have inputted (acidentially).
 * Only to be used on user input, not when parsing server-sent numbers.
 */
function parseIntWrapper(input: string) {
    return parseInt(input.replace(/[_.,]/gi, ""));
}

function formatNumber(input: number, distance: number = 3, separator: string = ".") {
    // If the number grows too large, calling .toString will give us a scientific notation
    if (Math.abs(input) > 2 ** 63) return input.toString(10);
    let base10String = input.toString(10);
    if (base10String.length <= distance) return base10String;
    /**
     *                 start here, then paste the separator afterwards
     *                     \/
     * index : 0 1 2 3 4 5 6 7 8 9
     * number: 5 2 5 1 8 6 5 0 9 6
     */
    for (let i = base10String.length - distance - 1; i >= 0; i -= distance) {
        base10String =
            base10String.substring(0, i + 1 /* the end argument always is one after the actual end index */) +
            separator +
            base10String.substring(i + 1);
    }
    return base10String;
}

process.on("beforeExit", () => {
    logFileHandle.close();
});

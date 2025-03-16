import axios, { type AxiosProgressEvent, type AxiosRequestConfig } from "axios";
import { SocksProxyAgent } from "socks-proxy-agent";
import readline from "node:readline/promises";
import { createWriteStream } from "node:fs";
import { Readable } from "node:stream";

const proxy = "socks5h://localhost:9050";
const agent = new SocksProxyAgent(proxy);

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

async function getOutboundIP() {
    const response = await client.get("https://httpbin.org/ip");
    return response.data?.origin ?? null;
}

const isThisYourIP = await rl.question(`Is this your IP: ${await getOutboundIP()} (y/n): `);
if (isThisYourIP.toLowerCase().startsWith("y")) {
    console.error("Aborting - Tor is not working!");
    process.exit(1);
}

const targetAddressUnvalidated = await rl.question("Enter your target address: ");
// Throws an error if invalid
const url = new URL(targetAddressUnvalidated);

const contentLength = await getContentLengthIfRangesSupported(url.toString());

const type = await rl.question("Select type: [1: new request; 2: start at offset] ");
if (type === "1") startRequest(0);
if (type === "2") startRequest(await startRequestAtOffset());

async function startRequestAtOffset() {
    const offsetString = await rl.question("Enter offset in bytes: ");
    const offset = parseInt(offsetString);
    if (isNaN(offset) || offset <= 0) {
        console.warn("No offset given!");
        return 0;
    }
    return offset;
}

async function startRequest(offset: number = 0) {
    const actualSize = contentLength - offset;
    const formattedContentLength = parseFileSize(actualSize);
    const desiredChunkCount = parseInt(
        await rl.question(`The content size is ${formattedContentLength} (${actualSize}). How many chunks should be used: `)
    );

    const chunkSize = Math.floor(actualSize / desiredChunkCount);
    const remainder = actualSize - chunkSize * desiredChunkCount;
    console.log(
        `Chunk size: ${parseFileSize(chunkSize)} (${chunkSize}); remainder: ${parseFileSize(remainder)} (${remainder}) => is correct: ${chunkSize * desiredChunkCount + remainder === actualSize}`
    );
    await sleep(3000);

    for (let i = 0; i < desiredChunkCount; i++) {
        const offset = i * chunkSize;
        const hasSucceeded = await downloadChunk(i, offset, chunkSize, actualSize);
        if (!hasSucceeded) {
            console.error(`Failed to download chunk ${i} - so at offset ${offset}, please restart at that offset!`);
            return;
        }
    }

    if (remainder === 0) return;
    const remainderOffset = chunkSize * desiredChunkCount;
    const hasSucceeded = await downloadChunk(-1, remainderOffset, remainder, actualSize);
    if (!hasSucceeded) {
        console.error("Failed to download remainder of size", remainder, "- so at offset", remainderOffset);
        return;
    }

    console.info("Everything has been downloaded! Nice :)");
}

function downloadChunk(chunkIndex: number, chunkOffset: number, chunkSize: number, totalDownloadSize: number) {
    return new Promise<boolean>(async (resolve) => {
        const writeStream = createWriteStream("download.output", { flags: "a" });
        const response = await client.get(url.toString(), {
            headers: {
                Range: `bytes=${chunkOffset}-${chunkOffset + chunkSize - 1}`
            },
            onDownloadProgress: (event) => logDownloadSpeed(event, chunkIndex, totalDownloadSize),
            responseType: "stream"
        });

        const reportedContentLength = response.headers["content-length"];
        if (
            (typeof reportedContentLength === "number" && chunkSize !== reportedContentLength) ||
            (typeof reportedContentLength === "string" && chunkSize.toString(10) !== reportedContentLength)
        ) {
            console.warn("Mismatch between content-length and desired size on chunk", chunkIndex, ":", chunkSize, reportedContentLength);
            resolve(false);
        }

        const stream = response.data as Readable;
        stream.pipe(writeStream);
        stream.on("error", (error) => {
            writeStream.close(() => resolve(false));
            console.error(error);
        });
        stream.once("end", () => {
            writeStream.close(() => resolve(true));
        });
    });
}

let alreadyDownloadedBytes = 0;
function logDownloadSpeed(event: AxiosProgressEvent, currentChunk: number, totalDownloadSize: number) {
    if (!event.lengthComputable || !event.total || !event.download) return;

    alreadyDownloadedBytes += event.bytes;

    console.clear();
    const timestamp = getCurrentTimestamp();
    const totalRemainder = totalDownloadSize - alreadyDownloadedBytes;
    const secondsUntilFinish = event.rate ? Math.floor(totalRemainder / event.rate) : null;
    console.log(`${timestamp} Chunk ${currentChunk}: ${((event.progress ?? 0) * 100).toFixed(3)}% (${event.loaded}/${event.total})`);
    console.log(`${timestamp} Download Speed: ${parseFileSize(event.rate ?? 0)}/s`);
    console.log(`${timestamp} ETA chunk: ${event.estimated?.toFixed(3)} seconds`);
    console.log(
        `${timestamp} Total downloaded: ${((alreadyDownloadedBytes / totalDownloadSize) * 100).toFixed(3)}% (${alreadyDownloadedBytes}/${totalDownloadSize})`
    );
    if (secondsUntilFinish) console.log(`${timestamp} ETA total: ${calculateDateDistance(Date.now(), Date.now() + secondsUntilFinish * 1000)}`);
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

function getCurrentTimestamp() {
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

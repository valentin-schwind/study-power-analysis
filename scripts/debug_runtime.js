const path = require("path");
const { JSDOM, VirtualConsole } = require("jsdom");

const rootDir = path.resolve(__dirname, "..");
const indexPath = path.join(rootDir, "index.html");

const virtualConsole = new VirtualConsole();
virtualConsole.on("log", (...args) => console.log("[browser log]", ...args));
virtualConsole.on("warn", (...args) => console.warn("[browser warn]", ...args));
virtualConsole.on("error", (...args) => console.error("[browser error]", ...args));
virtualConsole.on("jsdomError", (error) => console.error("[jsdom error]", error));

async function main() {
    const dom = await JSDOM.fromFile(indexPath, {
        url: "file://" + indexPath.replace(/\\/g, "/"),
        resources: "usable",
        runScripts: "dangerously",
        pretendToBeVisual: true,
        virtualConsole,
    });

    const { window } = dom;

    window.addEventListener("error", (event) => {
        console.error("[window error]", event.message, event.error && event.error.stack);
    });

    await new Promise((resolve) => {
        window.addEventListener("load", () => {
            setTimeout(resolve, 250);
        });
    });

    console.log("[state] page loaded");
    console.log("[state] initial rowWAIT:", window.document.querySelector("#rowWAIT")?.textContent?.trim());

    const exampleButton = window.document.querySelector("#btnExample2x4Mixed");
    if (!exampleButton) {
        throw new Error("Example button not found.");
    }

    exampleButton.click();

    for (let iteration = 0; iteration < 20; iteration++) {
        await new Promise((resolve) => setTimeout(resolve, 250));
        const rowWait = window.document.querySelector("#rowWAIT")?.textContent?.trim();
        const sampleWaitVisible = window.document.querySelector("#sampleSizePleaseWait")?.style?.display !== "none";
        const sliderVisible = window.document.querySelector("#sampleSizeSlider")?.style?.display !== "none";
        console.log("[poll]", iteration, { rowWait, sampleWaitVisible, sliderVisible });
    }

    const effectSizeLabel = window.document.querySelector("#effectSizeLabel")?.innerHTML;
    const powerHtmlLength = window.document.querySelector("#power")?.innerHTML?.length || 0;
    console.log("[state] final effect label:", effectSizeLabel);
    console.log("[state] final power html length:", powerHtmlLength);
}

main().catch((error) => {
    console.error("[fatal]", error && error.stack ? error.stack : error);
    process.exitCode = 1;
});

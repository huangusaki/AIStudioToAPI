// Build returns cumulative snapshots. Only completed model text is an API answer.
function extractSnapshots(response) {
    const failRpc = code => {
        const statuses = {
            3: 400,
            4: 504,
            5: 404,
            7: 403,
            8: 429,
            9: 400,
            10: 409,
            11: 400,
            12: 501,
            13: 500,
            14: 503,
            16: 401,
        };
        const status = statuses[code] || (code >= 400 && code <= 599 ? code : 502);
        throw Object.assign(new Error(`Build RPC failed (${code})`), { status });
    };
    const rpcError = value => {
        if (Array.isArray(value) && typeof value[0] === "number" && typeof value[1] === "string") {
            failRpc(value[0]);
        }
        if (value?.error) failRpc(value.error.code || "unknown");
    };
    rpcError(response);
    if (!Array.isArray(response) || response.length !== 1 || !Array.isArray(response[0])) {
        throw new Error("Invalid Build response envelope");
    }
    rpcError(response[0]);
    const snapshots = [];
    for (const event of response[0]) {
        rpcError(event);
        if (!Array.isArray(event?.[2])) throw new Error("Invalid Build event");
        for (const record of event[2]) {
            rpcError(record);
            if (!Array.isArray(record?.[0])) throw new Error("Invalid Build record");
            const messages = record[0].filter(message => message?.[1] === "model");
            if (!messages.length) continue;
            snapshots.push({
                complete: record[7] != null && record[12] === 1,
                generationId: record[16],
                model: record[13],
                text: messages
                    .flatMap(message => message[0] || [])
                    .filter(part => part?.[12] !== 1 && typeof part?.[1] === "string")
                    .map(part => part[1])
                    .join(""),
            });
        }
    }
    return snapshots;
}

module.exports = { extractSnapshots };

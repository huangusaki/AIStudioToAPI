// Build returns cumulative snapshots. Only completed model text is an API answer.
function extractSnapshots(response) {
    const rpcError = value => {
        if (Array.isArray(value) && typeof value[0] === "number" && typeof value[1] === "string") {
            throw new Error(`Build RPC failed (${value[0]})`);
        }
        if (value?.error) throw new Error(`Build RPC failed (${value.error.code || "unknown"})`);
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

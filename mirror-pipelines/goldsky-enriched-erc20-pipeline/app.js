const express = require('express');
const fs = require('fs');
const app = express();

// Middleware to parse JSON
app.use(express.json());

// Load token metadata from tokens.json on startup
// In production, you might want to replace this for an actual token API like coingecko for live data
let tokenMetadata = {};
fs.readFile('./tokens.json', (err, data) => {
    if (err) {
        console.error("Error loading token metadata:", err);
        return;
    }
    tokenMetadata = JSON.parse(data); // Store parsed token metadata
});

// Transform endpoint: enriches transfer events with token data
app.post('/transform', async (req, res) => {
    const events = req.body;
    // Expected shape of the data https://docs.goldsky.com/reference/schema/curated-schemas#erc-20
    const transformedEvents = events.map(event => {
        // Fetch token metadata from the loaded JSON file
        const token = tokenMetadata[event.address.toLowerCase()];
        // Define the base response structure
        const baseResponse = {
            id: event.id,
            sender: event.sender,
            recipient: event.recipient,
            converted_amount: "N/A",
            token_address: event.address,
            token_symbol: "N/A",
            token_decimals: "N/A",
            transaction_hash: event.transaction_hash,
            block_hash: event.block_hash,
            block_number: event.block_number,
            block_timestamp: event.block_timestamp,
        }
        if (token) {
            // Enrich the event with token metadata
            return {
                ...baseResponse,
                converted_amount: (parseInt(event.amount) / Math.pow(10, token.decimals)).toString(), // Convert raw value
                token_symbol: token.symbol,
                token_decimals: token.decimals,
            };
        }
        // Return the base response for unknown tokens
        // this should never happen thanks to the source filters but it's good to add defensive code
        return baseResponse;
    });
    res.json(transformedEvents);
});

// Start the server
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
    console.log(`Transform server running on port ${PORT}`);
});

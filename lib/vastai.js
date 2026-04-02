import axios from 'axios';
import 'dotenv/config';

// Ensure you have your Vast.ai API key set in the environment variable VAST_API_KEY
const API_KEY = process.env.VAST_API_KEY || "PUT_YOUR_VASTAI_API_KEY_HERE";

// Base URL for Vast.ai API endpoints
const VASTAI_API = 'https://console.vast.ai/api/v0';

/**
 * Performs a call to the Vast.ai API with the specified method and data.
 * @see https://docs.vast.ai/ for details
 * 
 * @param {string} method - The API method to call.
 * @param {object} data - The data to send with the API request.
 * @returns {object} - The response data from the API.
 */
async function vastaiCall(method, data) {
  let res = {};
  try {
    res = await axios.post(
      `${VASTAI_API}/${method}/`,
      data,
      {
        headers: {
          Authorization: `Bearer ${API_KEY}`,
          "Content-Type": "application/json",
        },
      }
    );
  } catch (err) {
    console.error("Error:", err.response?.data || err.message);
  }
  return res && res.data ? res.data : {};
}

/**
 * Searches for offers on Vast.ai based on the provided search parameters.
 *
 * @param {object} searchParams - The parameters to filter the search results.
 * @returns {array} - An array of offers matching the search criteria.
 */
export async function vastaiSearchOffers(searchParams = {}) {
  const data = await vastaiCall("bundles", searchParams);
  return data.offers || [];
}

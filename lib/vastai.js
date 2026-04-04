import axios from 'axios';
import 'dotenv/config';

// Vast.ai API key configured through the environment.
const API_KEY = process.env.VAST_API_KEY || 'PUT_YOUR_VASTAI_API_KEY_HERE';

// Base URL prefix for Vast.ai API endpoints, version suffix is appended in helpers below.
const VASTAI_API = 'https://console.vast.ai/api/v';

/**
 * Builds the authorization headers required for Vast.ai API calls.
 *
 * @returns {{ Authorization: string, 'Content-Type': string }} Request headers.
 */
function getHeaders() {
  return {
    Authorization: `Bearer ${API_KEY}`,
    'Content-Type': 'application/json',
  };
}

/**
 * Performs a POST request to a Vast.ai API endpoint.
 *
 * @param {string} method API method name without version prefix.
 * @param {object} [data={}] JSON payload sent in the request body.
 * @param {number} [version=0] Vast.ai API version.
 * @returns {Promise<object>} Parsed JSON response body or an empty object on error.
 */
async function vastaiPost(method, data = {}, version = 0) {
  try {
    const res = await axios.post(
      `${VASTAI_API}${version}/${method}/`,
      data,
      { headers: getHeaders() }
    );

    return res?.data || {};
  } catch (err) {
    console.error('Vast.ai POST error:', err.response?.data || err.message);
    return {};
  }
}

/**
 * Performs a GET request to a Vast.ai API endpoint.
 *
 * @param {string} path API path without version prefix.
 * @param {object} [params={}] Query string parameters.
 * @param {number} [version=1] Vast.ai API version.
 * @returns {Promise<object>} Parsed JSON response body or an empty object on error.
 */
async function vastaiGet(path, params = {}, version = 1) {
  try {
    const res = await axios.get(
      `${VASTAI_API}${version}/${path}/`,
      {
        headers: getHeaders(),
        params,
      }
    );

    return res?.data || {};
  } catch (err) {
    console.error('Vast.ai GET error:', err.response?.data || err.message);
    return {};
  }
}

/**
 * Performs a PUT request to a Vast.ai API endpoint.
 *
 * @param {string} path API path without version prefix.
 * @param {object} [data={}] JSON payload sent in the request body.
 * @param {number} [version=0] Vast.ai API version.
 * @returns {Promise<object>} Parsed JSON response body or an empty object on error.
 */
async function vastaiPut(path, data = {}, version = 0) {
  try {
    const res = await axios.put(
      `${VASTAI_API}${version}/${path}/`,
      data,
      { headers: getHeaders() }
    );

    return res?.data || {};
  } catch (err) {
    console.error('Vast.ai PUT error:', err.response?.data || err.message);
    return err.response?.data || {};
  }
}

/**
 * Searches Vast.ai offers using the bundles endpoint.
 *
 * @param {object} [searchParams={}] Offer search filters.
 * @returns {Promise<object[]>} List of matching offers.
 */
export async function vastaiSearchOffers(searchParams = {}) {
  const data = await vastaiPost('bundles', searchParams);
  return data.offers || [];
}

/**
 * Returns the current user instances from Vast.ai.
 *
 * @param {object} [params={}] Optional query parameters supported by the instances endpoint.
 * @returns {Promise<object[]>} List of instances visible to the API key.
 */
export async function vastaiShowInstances(params = {}) {
  const data = await vastaiGet('instances', params, 1);
  return data.instances || [];
}

/**
 * Changes a Vast.ai instance state to running or stopped.
 *
 * @param {number|string} instanceId Instance identifier.
 * @param {'running'|'stopped'} state Desired target state.
 * @returns {Promise<object>} Vast.ai response object.
 */
export async function vastaiManageInstance(instanceId, state) {
  return vastaiPut(`instances/${instanceId}`, { state }, 0);
}

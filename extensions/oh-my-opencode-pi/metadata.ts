import packageJson from "../../package.json" with { type: "json" };

export const PANTHEON_PACKAGE_NAME = packageJson.name;
export const PANTHEON_PACKAGE_VERSION = packageJson.version;
export const PANTHEON_USER_AGENT = `${PANTHEON_PACKAGE_NAME}/${PANTHEON_PACKAGE_VERSION}`;

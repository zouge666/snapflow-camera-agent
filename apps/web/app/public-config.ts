const defaultGitHubUrl = "https://github.com/zouge666/snapflow-camera-agent";

type PublicEnvironment = Readonly<Record<string, string | undefined>>;

export type PublicConfig = Readonly<{
  githubUrl: string;
}>;

export function getPublicConfig(
  environment: PublicEnvironment = process.env,
): PublicConfig {
  const configuredUrl = environment.PUBLIC_GITHUB_URL?.trim();
  const githubUrl = new URL(configuredUrl || defaultGitHubUrl);
  const pathParts = githubUrl.pathname.split("/").filter(Boolean);

  if (
    githubUrl.protocol !== "https:" ||
    !["github.com", "www.github.com"].includes(githubUrl.hostname) ||
    pathParts.length < 2
  ) {
    throw new Error("PUBLIC_GITHUB_URL must be an HTTPS GitHub repository URL");
  }

  return { githubUrl: githubUrl.toString().replace(/\/$/, "") };
}

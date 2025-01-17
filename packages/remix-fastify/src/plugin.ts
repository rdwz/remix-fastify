import * as path from "node:path";
import { pathToFileURL, URL } from "node:url";
import type { FastifyPluginAsync, FastifyReply } from "fastify";
import fastifyStatic from "@fastify/static";
import fastifyEarlyHints from "@fastify/early-hints";
import type { ServerBuild } from "@remix-run/node";
import fp from "fastify-plugin";
import fastifyRacing from "fastify-racing";
import invariant from "tiny-invariant";

import type { GetLoadContextFunction } from "./server";
import { createRequestHandler } from "./server";
import type { StaticFile } from "./utils";
import { getEarlyHintLinks, getStaticFiles, purgeRequireCache } from "./utils";

interface PluginOptions {
  /**
   * The Remix build to use.
   * This can either be a path to the build or the build itself.
   */
  build?: ServerBuild | string;
  /**
   * The mode your app is running in.
   * This is used to determine how to handle errors.
   * @default process.env.NODE_ENV
   */
  mode?: string;
  /**
   * The root directory of your app.
   * This is used to resolve the `public` directory.
   * @default process.cwd()
   */
  rootDir?: string;
  /**
   * A function that returns the value to use as `context` in route `loader` and
   * `action` functions.
   *
   * You can think of this as an escape hatch that allows you to pass
   * environment/platform-specific values through to your loader/action.
   */
  getLoadContext?: GetLoadContextFunction;
  /**
   * purge the require cache in development when not using the new dev server
   * @default false
   */
  purgeRequireCacheInDevelopment?: boolean;
  /**
   * enable early hints
   * note this won't include any imports from your remix `links()` function.
   * it will only include the js needed to render the current page
   * @default true
   */
  unstable_earlyHints?: boolean;
}

async function loadBuild(build: ServerBuild | string): Promise<ServerBuild> {
  if (typeof build === "string") {
    if (!build.endsWith(".js")) {
      build = path.join(build, "index.js");
    }
    let fileURL = pathToFileURL(build);
    fileURL.searchParams.set("ts", Date.now().toString());
    let module = await import(fileURL.toString());
    return module.default;
  }

  return build;
}

let remixFastify: FastifyPluginAsync<PluginOptions> = async (
  fastify,
  options = {},
) => {
  let {
    build,
    mode = process.env.NODE_ENV,
    rootDir = process.cwd(),
    purgeRequireCacheInDevelopment = false,
    unstable_earlyHints: earlyHints = true,
  } = options;
  invariant(build, "you must pass a remix build to the plugin");
  let serverBuild: ServerBuild = await loadBuild(build);

  if (!fastify.hasContentTypeParser("*")) {
    fastify.addContentTypeParser("*", (_request, payload, done) => {
      done(null, payload);
    });
  }

  if (earlyHints) {
    await fastify.register(fastifyEarlyHints, { warn: true });
  }
  await fastify.register(fastifyRacing, { handleError: true });

  let PUBLIC_DIR = path.join(rootDir, "public");

  fastify.register(fastifyStatic, {
    root: PUBLIC_DIR,
    // this needs to be false so our regular requests can still be served
    wildcard: false,
    // we handle serving the files ourselves as you cant stack roots (public/build, public)
    // and it won't pick up new files in dev
    serve: false,
  });

  function sendAsset(reply: FastifyReply, file: StaticFile) {
    return reply.sendFile(file.filePublicPath, rootDir, {
      maxAge: file.isBuildAsset ? "1y" : "1h",
      immutable: file.isBuildAsset,
    });
  }

  if (mode === "development") {
    // TODO: investigate a more streamline way to do this
    // this doesn't *feel* right
    fastify.addHook("onRequest", (request, reply, done) => {
      let staticFiles = getStaticFiles({
        assetsBuildDirectory: serverBuild.assetsBuildDirectory,
        publicPath: serverBuild.publicPath,
        rootDir,
      });

      let origin = `${request.protocol}://${request.hostname}`;
      let url = new URL(`${origin}${request.url}`);

      let staticFile = staticFiles.find((file) => {
        return url.pathname === file.browserAssetUrl;
      });

      if (staticFile) {
        return sendAsset(reply, staticFile);
      }

      done();
    });
  } else {
    let staticFiles = getStaticFiles({
      assetsBuildDirectory: serverBuild.assetsBuildDirectory,
      publicPath: serverBuild.publicPath,
      rootDir,
    });

    for (let staticFile of staticFiles) {
      fastify.get(staticFile.browserAssetUrl, (_request, reply) => {
        return sendAsset(reply, staticFile);
      });
    }
  }

  if (mode === "development" && typeof build === "string") {
    fastify.all("*", async (request, reply) => {
      invariant(build, "you must pass a remix build to the plugin");
      invariant(
        typeof build === "string",
        `to support "HMR" you must pass a path to the build`,
      );

      if (purgeRequireCacheInDevelopment) purgeRequireCache(build);

      let loaded = await loadBuild(build);

      if (earlyHints) {
        let links = getEarlyHintLinks(request, loaded);
        await reply.writeEarlyHintsLinks(links);
      }

      return createRequestHandler({
        build: loaded,
        mode,
        getLoadContext: options.getLoadContext,
      })(request, reply);
    });
  } else {
    fastify.all("*", async (request, reply) => {
      if (earlyHints) {
        let links = getEarlyHintLinks(request, serverBuild);
        await reply.writeEarlyHintsLinks(links);
      }
      return createRequestHandler({
        build: serverBuild,
        mode,
        getLoadContext: options.getLoadContext,
      })(request, reply);
    });
  }
};

export let remixFastifyPlugin = fp(remixFastify, {
  name: "@mcansh/remix-fastify",
  fastify: "^3.29.0 || ^4.0.0",
});

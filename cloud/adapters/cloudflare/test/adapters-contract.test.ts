import { expect, it } from "vitest";
import { contract } from "../../../../test/cloud-adapters-requests.ts";
import { call } from "./helpers";

it("runs the common adapter request contract in workerd", async () => {
  await contract((path, method, body) => call(path, undefined, method, body), {
    equal: (actual, expected) => expect(actual).toBe(expected),
    deepEqual: (actual, expected) => expect(actual).toEqual(expected),
  });
});

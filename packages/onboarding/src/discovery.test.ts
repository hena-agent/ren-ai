import { Schema } from "effect";
import { expect, test } from "vitest";
import { DiscoveryRequest, PublicPersona } from "./discovery.ts";

const profile = {
  id: "harin",
  name: "하린",
  bio: "공개 소개",
  imageUrl: "https://example.net/first.jpg",
};
const pair = { anime: "https://example.net/anime.jpg", photo: "https://example.net/photo.jpg" };

test("local Discovery accepts loopback HTTP portraits while rejecting other insecure origins", () => {
  const decode = Schema.decodeUnknownSync(PublicPersona);
  for (const host of ["localhost", "127.0.0.1", "[::1]"]) {
    const imageUrl = `http://${host}:3729/discovery/images/01234567-89ab-cdef-0123-456789abcdef.png`;
    const local = {
      ...profile,
      imageUrl,
      portraits: { anime: imageUrl, photo: imageUrl },
      secondaryPortraits: [{ style: "photo", imageUrl }],
    };
    expect(decode(local)).toEqual(local);
  }
  for (const imageUrl of [
    "http://example.net/photo.jpg",
    "http://localhost.example.net/photo.jpg",
    "http://127.0.0.1.example.net/photo.jpg",
    "ftp://127.0.0.1/photo.jpg",
  ])
    expect(() => decode({ ...profile, imageUrl })).toThrow(/imageUrl/);
});

test("public galleries retain complete image pairs and reject unsafe or partial collections", () => {
  const decode = Schema.decodeUnknownSync(PublicPersona);
  expect(decode(profile)).toEqual(profile);
  for (const count of [1, 6]) {
    const portraitGallery = Array.from({ length: count }, () => pair);
    expect(decode({ ...profile, portraitGallery })).toEqual({ ...profile, portraitGallery });
  }
  for (const portraitGallery of [
    [],
    Array.from({ length: 7 }, () => pair),
    [{}],
    [{ anime: pair.anime }],
    [{ ...pair, photo: "javascript:alert(1)" }],
  ])
    expect(() => decode({ ...profile, portraitGallery })).toThrow(/portraitGallery/);
});

test("a discovery registration requires contact, consent, verification and unique valid liked IDs", () => {
  const request = {
    handle: "person@example.com",
    locale: "ko",
    privacyNoticeVersion: "v1",
    turnstileToken: "human",
    likedPersonaIDs: ["harin"],
  };
  const decode = Schema.decodeUnknownSync(DiscoveryRequest);
  expect(decode(request)).toEqual(request);
  for (const input of [
    {},
    { ...request, handle: "invalid" },
    { ...request, privacyNoticeVersion: "" },
    { ...request, turnstileToken: "" },
    { ...request, likedPersonaIDs: [] },
    { ...request, likedPersonaIDs: ["harin", "harin"] },
    { ...request, likedPersonaIDs: ["../private"] },
  ])
    expect(() => decode(input)).toThrow(
      /handle|privacyNoticeVersion|turnstileToken|likedPersonaIDs/,
    );
});

test("independent public images accept either main style and ten mixed secondary images, rejecting malformed independent fields", () => {
  const decode = Schema.decodeUnknownSync(PublicPersona);
  for (const portraits of [{ anime: pair.anime }, { photo: pair.photo }, pair])
    expect(decode({ ...profile, portraits }).portraits).toEqual(portraits);
  const secondaryPortraits = Array.from({ length: 10 }, (_, index) => ({
    style: index % 2 ? "anime" : "photo",
    imageUrl: pair.photo,
  }));
  expect(decode({ ...profile, secondaryPortraits }).secondaryPortraits).toEqual(secondaryPortraits);
  for (const fields of [
    { portraits: {} },
    { portraits: { anime: "" } },
    { portraits: { photo: "javascript:alert(1)" } },
    { secondaryPortraits: [...secondaryPortraits, secondaryPortraits[0]] },
    { secondaryPortraits: [{ style: "other", imageUrl: pair.photo }] },
    { secondaryPortraits: [{ style: "photo", imageUrl: "http://example.net/photo.jpg" }] },
    { secondaryPortraits: [{ style: "photo" }] },
  ])
    expect(() => decode({ ...profile, ...fields })).toThrow(/portraits|secondaryPortraits/);
});

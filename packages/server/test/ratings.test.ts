import assert from "node:assert/strict";
import { mapPlexRatings } from "../src/services/ratings.js";

const ratings = mapPlexRatings({
  Rating: [
    { image: "imdb://image.rating", type: "audience", value: 7.6 },
    { image: "themoviedb://image.rating", type: "audience", value: 7.3 },
    { image: "rottentomatoes://image.rating.ripe", type: "critic", value: 6.2 },
    { image: "rottentomatoes://image.rating.upright", type: "audience", value: 8.5 },
  ],
});
assert.deepEqual(ratings, { imdb: 7.6, tmdb: 73, rtCritic: 62, rtAudience: 85 });

assert.deepEqual(mapPlexRatings({
  rating: 8.1,
  ratingImage: "rottentomatoes://image.rating.ripe",
  audienceRating: 9.2,
  audienceRatingImage: "rottentomatoes://image.rating.upright",
}), { imdb: null, tmdb: null, rtCritic: 81, rtAudience: 92 });

console.log("ratings tests passed");

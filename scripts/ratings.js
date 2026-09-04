const inverseLogCurve = (x, a, b) => {
  return 1 / Math.log10(Math.pow(10, 1 / a) + x * b);
};

const updateRating = (initialRating, opponentRating, won) => {
  let newRating = initialRating;

  let ratingDiff = opponentRating - initialRating;
  let handicapDiff = ratingDiff / 100;

  // Cap the handicap difference to a maximum of 8
  if (handicapDiff > 8) handicapDiff = 8;
  else if (handicapDiff < -8) handicapDiff = -8;

  // Calculate ERC and URC based on handicap difference
  let ercDepConst = 0.05; // Suggested constant for ERC calculation
  let upsetDepConst = 1.1 * 0.01; // Suggested constant for URC calculation
  let initialErc = 9.0; // Suggested initial ERC value

  let erc = inverseLogCurve(Math.abs(handicapDiff), initialErc, ercDepConst);
  let upsetProbability =
    inverseLogCurve(Math.abs(handicapDiff), 50.0, upsetDepConst) / 100.0;

  let urc = Math.round((erc * (1 - upsetProbability)) / upsetProbability);

  // Adjust rating based on match outcome
  if (won) {
    if (handicapDiff > 0) {
      // Player beat higher rated player
      newRating += urc;
    } // Player beat lower rated player
    else {
      newRating += erc;
    }
  } else {
    if (handicapDiff > 0) {
      // Player lost to higher rated player
      newRating -= erc;
    } // Player lost to lower rated player
    else {
      newRating -= urc;
    }
  }

  return Math.round(newRating);
};

const readjustRating = (newRating, initialRating = null) => {
  // No prior rating
  if (initialRating === null) {
  }

  // Prior rating exists
};

export { updateRating, readjustRating };

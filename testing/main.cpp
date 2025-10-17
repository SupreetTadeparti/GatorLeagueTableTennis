#include <iostream>
#include <math.h>
#include <vector>

struct Match
{
    int opponentRating;
    bool won;
};

// Fast start, slowing middle, slow end
float inverseLogCurve(float x, float a, float b)
{
    return 1 / (log10(pow(10, 1 / a) + x * b));
}

// Slow start, fast middle, slow end
int tanhCurve(float x, float maxDiff = 30.0f, float depConst = 0.8f, float d = -2.0f)
{
    // a - btanh(cx + d)
    // b = difference between converging max and min values / 2
    // c = rate of convergence
    // d = horizontal shift

    int a = 50 + maxDiff / 2.0f * tanh(d);

    return a - maxDiff / 2.0f * tanh(x * depConst + d);
}

int computeNewRating(int oldRating, std::vector<Match> playerMatches)
{
    int newRating = oldRating;
    for (const Match &match : playerMatches)
    {
        int opponentRating = match.opponentRating;
        bool won = match.won;

        int ratingDiff = opponentRating - oldRating;
        int handicapDiff = ratingDiff / 100;

        // Cap the handicap difference to a maximum of 8
        if (handicapDiff > 8)
            handicapDiff = 8;
        else if (handicapDiff < -8)
            handicapDiff = -8;

        // Calculate ERC and URC based on handicap difference
        float ercDepConst = 0.05f;          // Suggested constant for ERC calculation
        float upsetDepConst = 1.1f * 0.01f; // Suggested constant for URC calculation
        float initialErc = 9.0f;            // Suggested initial ERC value

        float erc = inverseLogCurve(abs(handicapDiff), initialErc, ercDepConst);
        float upsetProbability = inverseLogCurve(abs(handicapDiff), 50.0f, upsetDepConst) / 100.0f;

        int urc = round(erc * (1 - upsetProbability) / upsetProbability);

        // Adjust rating based on match outcome
        if (won)
        {
            if (handicapDiff > 0) // Player beat higher rated player
            {
                newRating += urc;
            }
            else // Player beat lower rated player
            {
                newRating += erc;
            }
        }
        else
        {
            if (handicapDiff > 0) // Player lost to higher rated player
            {
                newRating -= erc;
            }
            else // Player lost to lower rated player
            {
                newRating -= urc;
            }
        }
    }

    return newRating;
}

int main()
{
    std::cout << "Enter original rating: ";
    int oldRating;
    std::cin >> oldRating;

    int numMatches;
    std::cout << "Enter number of matches: ";
    std::cin >> numMatches;

    std::vector<Match> playerMatches;

    for (int i = 0; i < numMatches; i++)
    {
        Match match;
        std::cout << "Enter opponent rating and match result (1 for win, 0 for loss): ";
        std::cin >> match.opponentRating >> match.won;
        playerMatches.push_back(match);
    }

    int newRating = computeNewRating(oldRating, playerMatches);
    std::cout << newRating << std::endl;

    return 0;
}
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title RandomnessConsumer
 * @notice Example contract demonstrating drand randomness request/fulfill pattern
 * @dev Users can replace this with their own contract - just emit an event and implement fulfillment
 *
 * Verification: The randomness is verifiable using drand's BLS12-381 signatures.
 * Chain info for verification:
 *   - Chain Hash: 8990e7a9aaed2ffed73dbd7092123d6f289930540d7651336225dc172e51b2ce
 *   - Public Key: 868f005eb8e6e4ca0a47c8a77ceaa5309a47978a7c71bc5cce96366b5d7a569937c529eeda66c7293784a9402801af31
 */
contract RandomnessConsumer {
    // ============ Structs ============

    struct RandomnessRequest {
        address requester;
        bool fulfilled;
        bytes32 randomness;
        uint64 round;
        bytes signature;
    }

    // ============ State ============

    /// @notice The Compose wallet authorized to fulfill requests
    address public fulfiller;

    /// @notice Counter for generating request IDs
    uint256 public nextRequestId;

    /// @notice Mapping of request ID to request data
    mapping(uint256 => RandomnessRequest) public requests;

    // ============ Events ============

    /// @notice Emitted when randomness is requested - Compose listens for this
    event RandomnessRequested(
        uint256 indexed requestId,
        address indexed requester
    );

    /// @notice Emitted when randomness is fulfilled with full proof data
    event RandomnessFulfilled(
        uint256 indexed requestId,
        bytes32 randomness,
        uint64 round,
        bytes signature
    );

    // ============ Errors ============

    error OnlyFulfiller();
    error RequestNotFound();
    error AlreadyFulfilled();

    // ============ Constructor ============

    /// @param _fulfiller The Compose wallet address authorized to fulfill requests
    constructor(address _fulfiller) {
        fulfiller = _fulfiller;
    }

    // ============ External Functions ============

    /**
     * @notice Request randomness - emits event that Compose listens to
     * @return requestId The ID of this request
     */
    function requestRandomness() external returns (uint256 requestId) {
        requestId = nextRequestId++;

        requests[requestId] = RandomnessRequest({
            requester: msg.sender,
            fulfilled: false,
            randomness: bytes32(0),
            round: 0,
            signature: ""
        });

        emit RandomnessRequested(requestId, msg.sender);
    }

    /**
     * @notice Fulfill a randomness request with drand proof data
     * @dev Only callable by the authorized fulfiller (Compose wallet)
     * @param requestId The request to fulfill
     * @param randomness The random value (sha256 of signature)
     * @param round The drand round number
     * @param signature The BLS signature for verification
     */
    function fulfillRandomness(
        uint256 requestId,
        bytes32 randomness,
        uint64 round,
        bytes calldata signature
    ) external {
        if (msg.sender != fulfiller) revert OnlyFulfiller();

        RandomnessRequest storage request = requests[requestId];
        if (request.requester == address(0)) revert RequestNotFound();
        if (request.fulfilled) revert AlreadyFulfilled();

        request.fulfilled = true;
        request.randomness = randomness;
        request.round = round;
        request.signature = signature;

        emit RandomnessFulfilled(requestId, randomness, round, signature);
    }

    // ============ View Functions ============

    /**
     * @notice Get the randomness for a fulfilled request
     * @param requestId The request ID
     * @return randomness The random value
     * @return round The drand round
     * @return signature The BLS signature for verification
     */
    function getRandomness(
        uint256 requestId
    )
        external
        view
        returns (bytes32 randomness, uint64 round, bytes memory signature)
    {
        RandomnessRequest storage request = requests[requestId];
        return (request.randomness, request.round, request.signature);
    }

    /**
     * @notice Check if a request has been fulfilled
     * @param requestId The request ID
     * @return Whether the request is fulfilled
     */
    function isFulfilled(uint256 requestId) external view returns (bool) {
        return requests[requestId].fulfilled;
    }

    /**
     * @notice Update the fulfiller address (for key rotation)
     * @param _fulfiller The new fulfiller address
     */
    function setFulfiller(address _fulfiller) external {
        if (msg.sender != fulfiller) revert OnlyFulfiller();
        fulfiller = _fulfiller;
    }
}

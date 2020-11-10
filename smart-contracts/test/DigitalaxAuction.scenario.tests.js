const {
  expectRevert,
  expectEvent,
  BN,
  ether,
  constants,
  balance
} = require('@openzeppelin/test-helpers');

const {expect} = require('chai');

const DigitalaxGarmentFactory = artifacts.require('DigitalaxGarmentFactory');
const DigitalaxAccessControls = artifacts.require('DigitalaxAccessControls');
const DigitalaxMaterials = artifacts.require('DigitalaxMaterials');
const DigitalaxGarmentNFT = artifacts.require('DigitalaxGarmentNFT');
const DigitalaxAuction = artifacts.require('DigitalaxAuctionMock');

const ERC1155Mock = artifacts.require('ERC1155Mock');

contract('DigitalaxAuction scenario tests', (accounts) => {
  const [admin, minter, owner, smartContract, platformFeeAddress, tokenHolder, designer, bidder, ...otherAccounts] = accounts;

  const EMPTY_BYTES = web3.utils.encodePacked('');

  beforeEach(async () => {
    // Setup access controls and enabled admin
    this.accessControls = await DigitalaxAccessControls.new({from: admin});
    await this.accessControls.addMinterRole(minter, {from: admin});
    await this.accessControls.addSmartContractRole(smartContract, {from: admin});

    // Setup child 1155 contract
    this.digitalaxMaterials = await DigitalaxMaterials.new(
      'DigitalaxMaterials',
      'DXM',
      this.accessControls.address,
      {from: owner}
    );

    // Setup parent 721 contract
    this.token = await DigitalaxGarmentNFT.new(
      this.accessControls.address,
      this.digitalaxMaterials.address,
      {from: admin}
    );

    // Setup auction
    this.auction = await DigitalaxAuction.new(
      this.accessControls.address,
      this.token.address,
      platformFeeAddress,
      {from: admin}
    );
    await this.accessControls.addSmartContractRole(this.auction.address, {from: admin});

    // Setup factory
    this.factory = await DigitalaxGarmentFactory.new(
      this.token.address,
      this.digitalaxMaterials.address,
      this.accessControls.address,
      {from: admin}
    );
    await this.accessControls.addSmartContractRole(this.factory.address, {from: admin});
  });

  const TOKEN_ONE_ID = new BN('1');

  const CHILD_ONE_ID = new BN('1');
  const CHILD_TWO_ID = new BN('2');
  const CHILD_THREE_ID = new BN('3');
  const CHILD_FOUR_ID = new BN('4');

  const child1 = 'child1';
  const child2 = 'child2';
  const child3 = 'child3';
  const child4 = 'child4';

  beforeEach(async () => {
    // Create children - creates 1155 token IDs: [1], [2], [3], [4]
    await this.factory.createNewChildren([child1, child2, child3, child4], {from: minter});
    expect(await this.digitalaxMaterials.uri(CHILD_ONE_ID)).to.be.equal(child1);
    expect(await this.digitalaxMaterials.uri(CHILD_TWO_ID)).to.be.equal(child2);
    expect(await this.digitalaxMaterials.uri(CHILD_THREE_ID)).to.be.equal(child3);

    // token 4 used as the attack token
    expect(await this.digitalaxMaterials.uri(CHILD_FOUR_ID)).to.be.equal(child4);

    // Create parent with children
    const randomGarmentURI = 'randomGarmentURI';
    const {receipt} = await this.factory.mintParentWithChildren(
      randomGarmentURI,
      designer,
      [CHILD_ONE_ID, CHILD_TWO_ID, CHILD_THREE_ID],
      [1, 2, 3],
      tokenHolder,
      {from: minter}
    );
    this.receipt = receipt;
  });

  describe.only('scenario 1: happy path creation, auction and burn', async () => {

    it('Garment and children are created', async () => {
      await expectEvent(this.receipt, 'GarmentCreated', {garmentTokenId: TOKEN_ONE_ID});
      await expectStrandBalanceOfGarmentToBe(TOKEN_ONE_ID, CHILD_ONE_ID, '1');
      await expectStrandBalanceOfGarmentToBe(TOKEN_ONE_ID, CHILD_TWO_ID, '2');
      await expectStrandBalanceOfGarmentToBe(TOKEN_ONE_ID, CHILD_THREE_ID, '3');
    });

    describe('Given an auction', async () => {

      beforeEach(async () => {
        // Give token holder minter role to setup an auction and approve auction
        await this.token.approve(this.auction.address, TOKEN_ONE_ID, {from: tokenHolder});
        await this.accessControls.addMinterRole(tokenHolder, {from: admin});

        // Create auction
        await this.auction.setNowOverride('2');
        await this.auction.createAuction(
          TOKEN_ONE_ID,
          '1',
          '0',
          '10',
          {from: tokenHolder}
        );

        // Place bid
        await this.auction.placeBid(TOKEN_ONE_ID, {from: bidder, value: ether('0.2')});
        await this.auction.setNowOverride('12');

        // Result it
        const {receipt} = await this.auction.resultAuction(TOKEN_ONE_ID, {from: admin});
        this.receipt = receipt;
      });

      it('the auction is resulted properly and token ownership assigned', async () => {
        await expectEvent(this.receipt, 'AuctionResulted', {
          garmentTokenId: TOKEN_ONE_ID,
          winner: bidder,
          winningBid: ether('0.2')
        });

        // top bidder now owns token
        expect(await this.token.ownerOf(TOKEN_ONE_ID)).to.be.equal(bidder);

        // Token still owns children
        await expectStrandBalanceOfGarmentToBe(TOKEN_ONE_ID, CHILD_ONE_ID, '1');
        await expectStrandBalanceOfGarmentToBe(TOKEN_ONE_ID, CHILD_TWO_ID, '2');
        await expectStrandBalanceOfGarmentToBe(TOKEN_ONE_ID, CHILD_THREE_ID, '3');
      });

      describe('Given user burns it', async () => {
        it('user destroys parent token and is assigned the composite children', async () => {

          // check balance are zero before burn
          expect(await this.digitalaxMaterials.balanceOf(bidder, CHILD_ONE_ID)).to.be.bignumber.equal('0');
          expect(await this.digitalaxMaterials.balanceOf(bidder, CHILD_TWO_ID)).to.be.bignumber.equal('0');
          expect(await this.digitalaxMaterials.balanceOf(bidder, CHILD_THREE_ID)).to.be.bignumber.equal('0');

          // bidder burns token to get at the 1155s
          await this.token.burn(TOKEN_ONE_ID, {from: bidder});

          // Token now burnt
          expect(await this.token.exists(TOKEN_ONE_ID)).to.equal(false);
          await expectRevert(
            this.token.tokenURI(TOKEN_ONE_ID), 'ERC721Metadata: URI query for nonexistent token',
          );

          // Token no long owns any balances
          await expectStrandBalanceOfGarmentToBe(TOKEN_ONE_ID, CHILD_ONE_ID, '0');
          await expectStrandBalanceOfGarmentToBe(TOKEN_ONE_ID, CHILD_TWO_ID, '0');
          await expectStrandBalanceOfGarmentToBe(TOKEN_ONE_ID, CHILD_THREE_ID, '0');

          // check owner now owns tokens
          expect(await this.digitalaxMaterials.balanceOf(bidder, CHILD_ONE_ID)).to.be.bignumber.equal('1');
          expect(await this.digitalaxMaterials.balanceOf(bidder, CHILD_TWO_ID)).to.be.bignumber.equal('2');
          expect(await this.digitalaxMaterials.balanceOf(bidder, CHILD_THREE_ID)).to.be.bignumber.equal('3');
        });
      });

    });
  });

  describe.only('scenario 2: happy path creation, auction and increasing balance post purchase', async () => {

    it('Garment and children are created', async () => {
      await expectEvent(this.receipt, 'GarmentCreated', {garmentTokenId: TOKEN_ONE_ID});
      await expectStrandBalanceOfGarmentToBe(TOKEN_ONE_ID, CHILD_ONE_ID, '1');
      await expectStrandBalanceOfGarmentToBe(TOKEN_ONE_ID, CHILD_TWO_ID, '2');
      await expectStrandBalanceOfGarmentToBe(TOKEN_ONE_ID, CHILD_THREE_ID, '3');
    });

    describe('Given an auction', async () => {

      beforeEach(async () => {
        // Give token holder minter role to setup an auction and approve auction
        await this.token.approve(this.auction.address, TOKEN_ONE_ID, {from: tokenHolder});
        await this.accessControls.addMinterRole(tokenHolder, {from: admin});

        // Create auction
        await this.auction.setNowOverride('2');
        await this.auction.createAuction(
          TOKEN_ONE_ID,
          '1',
          '0',
          '10',
          {from: tokenHolder}
        );

        // Place bid
        await this.auction.placeBid(TOKEN_ONE_ID, {from: bidder, value: ether('0.2')});
        await this.auction.setNowOverride('12');

        // Result it
        const {receipt} = await this.auction.resultAuction(TOKEN_ONE_ID, {from: admin});
        this.receipt = receipt;
      });

      it('the auction is resulted properly and token ownership assigned', async () => {
        await expectEvent(this.receipt, 'AuctionResulted', {
          garmentTokenId: TOKEN_ONE_ID,
          winner: bidder,
          winningBid: ether('0.2')
        });

        // top bidder now owns token
        expect(await this.token.ownerOf(TOKEN_ONE_ID)).to.be.equal(bidder);

        // Token still owns children
        await expectStrandBalanceOfGarmentToBe(TOKEN_ONE_ID, CHILD_ONE_ID, '1');
        await expectStrandBalanceOfGarmentToBe(TOKEN_ONE_ID, CHILD_TWO_ID, '2');
        await expectStrandBalanceOfGarmentToBe(TOKEN_ONE_ID, CHILD_THREE_ID, '3');
      });

      describe('Given user now tops up there existing child balances', async () => {

        // mint more balances of the children and send them to the new owner so they can topup
        beforeEach(async () => {

          // check balance are zero before
          expect(await this.digitalaxMaterials.balanceOf(bidder, CHILD_ONE_ID)).to.be.bignumber.equal('0');
          expect(await this.digitalaxMaterials.balanceOf(bidder, CHILD_TWO_ID)).to.be.bignumber.equal('0');
          expect(await this.digitalaxMaterials.balanceOf(bidder, CHILD_THREE_ID)).to.be.bignumber.equal('0');

          // send 5 tokens to the bidder
          await this.digitalaxMaterials.mintChild(CHILD_ONE_ID, '5', bidder, EMPTY_BYTES, {from: smartContract});
          await this.digitalaxMaterials.mintChild(CHILD_TWO_ID, '5', bidder, EMPTY_BYTES, {from: smartContract});
          await this.digitalaxMaterials.mintChild(CHILD_THREE_ID, '5', bidder, EMPTY_BYTES, {from: smartContract});

          // check balance are 5 for each type
          expect(await this.digitalaxMaterials.balanceOf(bidder, CHILD_ONE_ID)).to.be.bignumber.equal('5');
          expect(await this.digitalaxMaterials.balanceOf(bidder, CHILD_TWO_ID)).to.be.bignumber.equal('5');
          expect(await this.digitalaxMaterials.balanceOf(bidder, CHILD_THREE_ID)).to.be.bignumber.equal('5');
        });

        it('balances are updated', async () => {
          // Top up balances
          await this.digitalaxMaterials.safeTransferFrom(
            bidder, this.token.address, CHILD_ONE_ID, '5', web3.utils.encodePacked(TOKEN_ONE_ID),
            {from: bidder}
          );
          await this.digitalaxMaterials.safeTransferFrom(
            bidder, this.token.address, CHILD_TWO_ID, '5', web3.utils.encodePacked(TOKEN_ONE_ID),
            {from: bidder}
          );
          await this.digitalaxMaterials.safeTransferFrom(
            bidder, this.token.address, CHILD_THREE_ID, '5', web3.utils.encodePacked(TOKEN_ONE_ID),
            {from: bidder}
          );

          // check direct balance are now 0 for each type
          expect(await this.digitalaxMaterials.balanceOf(bidder, CHILD_ONE_ID)).to.be.bignumber.equal('0');
          expect(await this.digitalaxMaterials.balanceOf(bidder, CHILD_TWO_ID)).to.be.bignumber.equal('0');
          expect(await this.digitalaxMaterials.balanceOf(bidder, CHILD_THREE_ID)).to.be.bignumber.equal('0');

          // Check token now owns them
          await expectStrandBalanceOfGarmentToBe(TOKEN_ONE_ID, CHILD_ONE_ID, '6');
          await expectStrandBalanceOfGarmentToBe(TOKEN_ONE_ID, CHILD_TWO_ID, '7');
          await expectStrandBalanceOfGarmentToBe(TOKEN_ONE_ID, CHILD_THREE_ID, '8');
        });

        it('cannot add top-up existing children to someone else parent', async () => {
          // give tokenHolder 5 children
          await this.digitalaxMaterials.mintChild(CHILD_ONE_ID, '5', tokenHolder, EMPTY_BYTES, {from: smartContract});
          expect(await this.digitalaxMaterials.balanceOf(tokenHolder, CHILD_ONE_ID)).to.be.bignumber.equal('5');

          // Attempt to top up the child balances of another user
          const bidderOwnedToken = web3.utils.encodePacked(TOKEN_ONE_ID);
          await expectRevert(
            this.digitalaxMaterials.safeTransferFrom(
              tokenHolder, this.token.address, CHILD_ONE_ID, '5', bidderOwnedToken,
              {from: tokenHolder}
            ),
            'Cannot add children to tokens you dont own'
          );

          // balances stay the same
          expect(await this.digitalaxMaterials.balanceOf(tokenHolder, CHILD_ONE_ID)).to.be.bignumber.equal('5');
          await expectStrandBalanceOfGarmentToBe(TOKEN_ONE_ID, CHILD_ONE_ID, '1');
        });

        it('cannot add new children to someone else parent', async () => {

          // give tokenHolder 5 children of a new token
          await this.digitalaxMaterials.mintChild(CHILD_FOUR_ID, '5', tokenHolder, EMPTY_BYTES, {from: smartContract});
          expect(await this.digitalaxMaterials.balanceOf(tokenHolder, CHILD_FOUR_ID)).to.be.bignumber.equal('5');

          // Attempt to top up the child balances of another user for a new token
          const bidderOwnedToken = web3.utils.encodePacked(TOKEN_ONE_ID);
          await expectRevert(
            this.digitalaxMaterials.safeTransferFrom(
              tokenHolder, this.token.address, CHILD_FOUR_ID, '5', bidderOwnedToken,
              {from: tokenHolder}
            ),
            'Cannot add children to tokens you dont own'
          );

          // balances stay the same
          expect(await this.digitalaxMaterials.balanceOf(tokenHolder, CHILD_FOUR_ID)).to.be.bignumber.equal('5');
          await expectStrandBalanceOfGarmentToBe(TOKEN_ONE_ID, CHILD_FOUR_ID, '0');
        });

        it('cannot add new children from another 1155 token', async () => {
          const anotherChildContract = await ERC1155Mock.new();

          const ANOTHER_TOKEN_ID = 1;

          // Bidder owns 5 1155s from another contract
          await anotherChildContract.mint(ANOTHER_TOKEN_ID, '3', {from: bidder});
          expect(await anotherChildContract.balanceOf(bidder, ANOTHER_TOKEN_ID)).to.be.bignumber.equal('3');

          // try send from another 1155 to the parent
          await expectRevert(
            anotherChildContract.safeTransferFrom(
              bidder, this.token.address, ANOTHER_TOKEN_ID, '3', web3.utils.encodePacked(TOKEN_ONE_ID),
              {from: bidder}
            ),
            'Invalid child token contract'
          );
        });
      });
    });
  });

  describe('scenario 3: happy path creation, auction and additional children added', async () => {

    it('Garment and children are created', async () => {
      await expectEvent(this.receipt, 'GarmentCreated', {garmentTokenId: TOKEN_ONE_ID});
      await expectStrandBalanceOfGarmentToBe(TOKEN_ONE_ID, CHILD_ONE_ID, '1');
      await expectStrandBalanceOfGarmentToBe(TOKEN_ONE_ID, CHILD_TWO_ID, '2');
      await expectStrandBalanceOfGarmentToBe(TOKEN_ONE_ID, CHILD_THREE_ID, '3');
    });

    beforeEach(async () => {

    });

  });

  const expectStrandBalanceOfGarmentToBe = async (garmentTokenId, strandId, expectedStrandBalance) => {
    const garmentStrandBalance = await this.token.childBalance(
      garmentTokenId,
      this.digitalaxMaterials.address,
      strandId
    );
    expect(garmentStrandBalance).to.be.bignumber.equal(expectedStrandBalance);
  };

  const expectGarmentToOwnAGivenSetOfStrandIds = async (garmentId, childTokenIds) => {
    const garmentStrandIdsOwned = await this.token.childIdsForOn(
      garmentId,
      this.digitalaxMaterials.address
    );

    expect(garmentStrandIdsOwned.length).to.be.equal(childTokenIds.length);
    garmentStrandIdsOwned.forEach((strandId, idx) => {
      expect(strandId).to.be.bignumber.equal(childTokenIds[idx]);
    });
  };
});

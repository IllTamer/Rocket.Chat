import type {
	ILivechatDepartment,
	ILivechatPriority,
	IMessage,
	IOmnichannelServiceLevelAgreements,
	IRoom,
	IUser,
	MessageTypesValues,
	RocketChatRecordDeleted,
} from '@rocket.chat/core-typings';
import type { FindPaginated, IMessagesModel } from '@rocket.chat/model-typings';
import type { PaginatedRequest } from '@rocket.chat/rest-typings';
import type {
	AggregationCursor,
	Collection,
	CountDocumentsOptions,
	AggregateOptions,
	FindCursor,
	Db,
	Filter,
	FindOptions,
	IndexDescription,
	InsertOneResult,
	DeleteResult,
} from 'mongodb';
import { escapeRegExp } from '@rocket.chat/string-helpers';

import { BaseRaw } from './BaseRaw';
import { escapeExternalFederationEventId } from '../../../app/federation-v2/server/infrastructure/rocket-chat/adapters/MessageConverter';
import { readSecondaryPreferred } from '../../database/readSecondaryPreferred';

export class MessagesRaw extends BaseRaw<IMessage> implements IMessagesModel {
	constructor(db: Db, trash?: Collection<RocketChatRecordDeleted<IMessage>>) {
		super(db, 'message', trash);
	}

	protected modelIndexes(): IndexDescription[] {
		return [{ key: { 'federation.eventId': 1 }, sparse: true }];
	}

	findVisibleByMentionAndRoomId(
		username: IUser['username'],
		rid: IRoom['_id'],
		options: FindOptions<IMessage>,
	): FindPaginated<FindCursor<IMessage>> {
		const query: Filter<IMessage> = {
			'_hidden': { $ne: true },
			'mentions.username': username,
			rid,
		};

		return this.findPaginated(query, options);
	}

	findStarredByUserAtRoom(userId: IUser['_id'], roomId: IRoom['_id'], options: FindOptions<IMessage>): FindPaginated<FindCursor<IMessage>> {
		const query: Filter<IMessage> = {
			'_hidden': { $ne: true },
			'starred._id': userId,
			'rid': roomId,
		};

		return this.findPaginated(query, options);
	}

	findPaginatedByRoomIdAndType(
		roomId: IRoom['_id'],
		type: IMessage['t'],
		options: FindOptions<IMessage> = {},
	): FindPaginated<FindCursor<IMessage>> {
		const query = {
			rid: roomId,
			t: type,
		};

		return this.findPaginated(query, options);
	}

	// TODO: do we need this? currently not used anywhere
	findDiscussionsByRoom(rid: IRoom['_id'], options: FindOptions<IMessage>): FindCursor<IMessage> {
		const query: Filter<IMessage> = { rid, drid: { $exists: true } };

		return this.find(query, options);
	}

	findDiscussionsByRoomAndText(rid: IRoom['_id'], text: string, options: FindOptions<IMessage>): FindPaginated<FindCursor<IMessage>> {
		const query: Filter<IMessage> = {
			rid,
			drid: { $exists: true },
			msg: new RegExp(escapeRegExp(text), 'i'),
		};

		return this.findPaginated(query, options);
	}

	findAllNumberOfTransferredRooms({
		start,
		end,
		departmentId,
		onlyCount = false,
		options = {},
	}: {
		start: string;
		end: string;
		departmentId: ILivechatDepartment['_id'];
		onlyCount: boolean;
		options: PaginatedRequest;
	}): AggregationCursor<any> {
		// FIXME: aggregation type definitions
		const match = {
			$match: {
				t: 'livechat_transfer_history',
				ts: { $gte: new Date(start), $lte: new Date(end) },
			},
		};
		const lookup = {
			$lookup: {
				from: 'rocketchat_room',
				localField: 'rid',
				foreignField: '_id',
				as: 'room',
			},
		};
		const unwind = {
			$unwind: {
				path: '$room',
				preserveNullAndEmptyArrays: true,
			},
		};
		const group = {
			$group: {
				_id: {
					_id: null,
					departmentId: '$room.departmentId',
				},
				numberOfTransferredRooms: { $sum: 1 },
			},
		};
		const project = {
			$project: {
				_id: { $ifNull: ['$_id.departmentId', null] },
				numberOfTransferredRooms: 1,
			},
		};
		const firstParams: Exclude<Parameters<Collection<IMessage>['aggregate']>[0], undefined> = [match, lookup, unwind];
		if (departmentId) {
			firstParams.push({
				$match: {
					'room.departmentId': departmentId,
				},
			});
		}
		const sort = { $sort: options.sort || { name: 1 } };
		const params = [...firstParams, group, project, sort];
		if (onlyCount) {
			params.push({ $count: 'total' });
			return this.col.aggregate(params, { readPreference: readSecondaryPreferred() });
		}
		if (options.offset) {
			params.push({ $skip: options.offset });
		}
		if (options.count) {
			params.push({ $limit: options.count });
		}
		return this.col.aggregate(params, { allowDiskUse: true, readPreference: readSecondaryPreferred() });
	}

	getTotalOfMessagesSentByDate({ start, end, options = {} }: { start: Date; end: Date; options?: PaginatedRequest }): Promise<any[]> {
		const params: Exclude<Parameters<Collection<IMessage>['aggregate']>[0], undefined> = [
			{ $match: { t: { $exists: false }, ts: { $gte: start, $lte: end } } },
			{
				$lookup: {
					from: 'rocketchat_room',
					localField: 'rid',
					foreignField: '_id',
					as: 'room',
				},
			},
			{
				$unwind: {
					path: '$room',
				},
			},
			{
				$group: {
					_id: {
						_id: '$room._id',
						name: {
							$cond: [{ $ifNull: ['$room.fname', false] }, '$room.fname', '$room.name'],
						},
						t: '$room.t',
						usernames: {
							$cond: [{ $ifNull: ['$room.usernames', false] }, '$room.usernames', []],
						},
						date: {
							$concat: [{ $substr: ['$ts', 0, 4] }, { $substr: ['$ts', 5, 2] }, { $substr: ['$ts', 8, 2] }],
						},
					},
					messages: { $sum: 1 },
				},
			},
			{
				$project: {
					_id: 0,
					date: '$_id.date',
					room: {
						_id: '$_id._id',
						name: '$_id.name',
						t: '$_id.t',
						usernames: '$_id.usernames',
					},
					type: 'messages',
					messages: 1,
				},
			},
		];
		if (options.sort) {
			params.push({ $sort: options.sort });
		}
		if (options.count) {
			params.push({ $limit: options.count });
		}
		return this.col.aggregate(params, { readPreference: readSecondaryPreferred() }).toArray();
	}

	findLivechatClosedMessages(rid: IRoom['_id'], searchTerm?: string, options?: FindOptions<IMessage>): FindPaginated<FindCursor<IMessage>> {
		return this.findPaginated(
			{
				rid,
				$or: [{ t: { $exists: false } }, { t: 'livechat-close' }],
				...(searchTerm && { msg: new RegExp(escapeRegExp(searchTerm), 'ig') }),
			},
			options,
		);
	}

	findLivechatClosingMessage(rid: IRoom['_id'], options?: FindOptions<IMessage>): Promise<IMessage | null> {
		return this.findOne<IMessage>(
			{
				rid,
				t: 'livechat-close',
			},
			options,
		);
	}

	findLivechatMessages(rid: IRoom['_id'], options?: FindOptions<IMessage>): FindCursor<IMessage> {
		return this.find(
			{
				rid,
				$or: [{ t: { $exists: false } }, { t: 'livechat-close' }],
			},
			options,
		);
	}

	findVisibleByRoomIdNotContainingTypesBeforeTs(
		roomId: IRoom['_id'],
		types: IMessage['t'][],
		ts: Date,
		options?: FindOptions<IMessage>,
		showThreadMessages = true,
	): FindCursor<IMessage> {
		const query: Filter<IMessage> = {
			_hidden: {
				$ne: true,
			},
			rid: roomId,
			ts: { $lt: ts },
			...(!showThreadMessages && {
				$or: [
					{
						tmid: { $exists: false },
					},
					{
						tshow: true,
					},
				],
			}),
		};

		if (types.length > 0) {
			query.t = { $nin: types };
		}

		return this.find(query, options);
	}

	findVisibleByRoomIdNotContainingTypesAndUsers(
		roomId: IRoom['_id'],
		types: IMessage['t'][],
		users?: string[],
		options?: FindOptions<IMessage>,
		showThreadMessages = true,
	): FindCursor<IMessage> {
		const query: Filter<IMessage> = {
			_hidden: {
				$ne: true,
			},
			...(Array.isArray(users) && users.length > 0 && { 'u._id': { $nin: users } }),
			rid: roomId,
			...(!showThreadMessages && {
				$or: [
					{
						tmid: { $exists: false },
					},
					{
						tshow: true,
					},
				],
			}),
		};

		if (types.length > 0) {
			query.t = { $nin: types };
		}

		return this.find(query, options);
	}

	findLivechatMessagesWithoutClosing(rid: IRoom['_id'], options?: FindOptions<IMessage>): FindCursor<IMessage> {
		return this.find(
			{
				rid,
				t: { $exists: false },
			},
			options,
		);
	}

	async setBlocksById(_id: string, blocks: Required<IMessage>['blocks']): Promise<void> {
		await this.updateOne(
			{ _id },
			{
				$set: {
					blocks,
				},
			},
		);
	}

	async addBlocksById(_id: string, blocks: Required<IMessage>['blocks']): Promise<void> {
		await this.updateOne({ _id }, { $addToSet: { blocks: { $each: blocks } } });
	}

	async countRoomsWithStarredMessages(options: AggregateOptions): Promise<number> {
		const queryResult = await this.col
			.aggregate<{ _id: null; total: number }>(
				[
					{ $match: { 'starred._id': { $exists: true } } },
					{ $group: { _id: '$rid' } },
					{
						$group: {
							_id: null,
							total: { $sum: 1 },
						},
					},
				],
				options,
			)
			.next();

		return queryResult?.total || 0;
	}

	async countRoomsWithMessageType(type: IMessage['t'], options: AggregateOptions): Promise<number> {
		const queryResult = await this.col
			.aggregate<{ _id: null; total: number }>(
				[
					{ $match: { t: type } },
					{ $group: { _id: '$rid' } },
					{
						$group: {
							_id: null,
							total: { $sum: 1 },
						},
					},
				],
				options,
			)
			.next();

		return queryResult?.total || 0;
	}

	async countByType(type: IMessage['t'], options: CountDocumentsOptions): Promise<number> {
		return this.col.countDocuments({ t: type }, options);
	}

	async countRoomsWithPinnedMessages(options: AggregateOptions): Promise<number> {
		const queryResult = await this.col
			.aggregate<{ _id: null; total: number }>(
				[
					{ $match: { pinned: true } },
					{ $group: { _id: '$rid' } },
					{
						$group: {
							_id: null,
							total: { $sum: 1 },
						},
					},
				],
				options,
			)
			.next();

		return queryResult?.total || 0;
	}

	findPinned(options: FindOptions<IMessage>): FindCursor<IMessage> {
		const query: Filter<IMessage> = {
			t: { $ne: 'rm' as MessageTypesValues },
			_hidden: { $ne: true },
			pinned: true,
		};

		return this.find(query, options);
	}

	findPaginatedPinnedByRoom(roomId: IMessage['rid'], options: FindOptions<IMessage>): FindPaginated<FindCursor<IMessage>> {
		const query: Filter<IMessage> = {
			t: { $ne: 'rm' },
			_hidden: { $ne: true },
			pinned: true,
			rid: roomId,
		};

		return this.findPaginated(query, options);
	}

	findStarred(options: FindOptions<IMessage>): FindCursor<IMessage> {
		const query: Filter<IMessage> = {
			'_hidden': { $ne: true },
			'starred._id': { $exists: true },
		};

		return this.find(query, options);
	}

	async setFederationReactionEventId(username: string, _id: string, reaction: string, federationEventId: string): Promise<void> {
		await this.updateOne(
			{ _id },
			{
				$set: {
					[`reactions.${reaction}.federationReactionEventIds.${escapeExternalFederationEventId(federationEventId)}`]: username,
				} as any,
			},
		);
	}

	async unsetFederationReactionEventId(federationEventId: string, _id: string, reaction: string): Promise<void> {
		await this.updateOne(
			{ _id },
			{
				$unset: {
					[`reactions.${reaction}.federationReactionEventIds.${escapeExternalFederationEventId(federationEventId)}`]: 1,
				},
			},
		);
	}

	async findOneByFederationId(federationEventId: string): Promise<IMessage | null> {
		return this.findOne({ 'federation.eventId': federationEventId });
	}

	async setFederationEventIdById(_id: string, federationEventId: string): Promise<void> {
		await this.updateOne(
			{ _id },
			{
				$set: {
					'federation.eventId': federationEventId,
				},
			},
		);
	}

	async findOneByFederationIdAndUsernameOnReactions(federationEventId: string, username: string): Promise<IMessage | null> {
		return (
			await this.col
				.aggregate(
					[
						{
							$match: {
								t: { $ne: 'rm' },
							},
						},
						{
							$project: {
								document: '$$ROOT',
								reactions: { $objectToArray: '$reactions' },
							},
						},
						{
							$unwind: {
								path: '$reactions',
							},
						},
						{
							$match: {
								$and: [
									{ 'reactions.v.usernames': { $in: [username] } },
									{ [`reactions.v.federationReactionEventIds.${escapeExternalFederationEventId(federationEventId)}`]: username },
								],
							},
						},
						{ $replaceRoot: { newRoot: '$document' } },
					],
					{ readPreference: readSecondaryPreferred() },
				)
				.toArray()
		)[0] as IMessage;
	}

	createSLAHistoryWithRoomIdMessageAndUser(
		roomId: string,
		user: IMessage['u'],
		sla?: Pick<IOmnichannelServiceLevelAgreements, 'name'>,
	): Promise<InsertOneResult<IMessage>> {
		return this.insertOne({
			t: 'omnichannel_sla_change_history',
			rid: roomId,
			msg: '',
			ts: new Date(),
			groupable: false,
			u: {
				_id: user._id,
				username: user.username,
				name: user.name,
			},
			slaData: {
				definedBy: {
					_id: user._id,
					username: user.username,
				},
				...(sla && { sla }),
			},
		});
	}

	createPriorityHistoryWithRoomIdMessageAndUser(
		roomId: string,
		user: IMessage['u'],
		priority?: Pick<ILivechatPriority, 'name' | 'i18n'>,
	): Promise<InsertOneResult<IMessage>> {
		return this.insertOne({
			t: 'omnichannel_priority_change_history',
			rid: roomId,
			msg: '',
			ts: new Date(),
			groupable: false,
			u: {
				_id: user._id,
				username: user.username,
				name: user.name,
			},
			priorityData: {
				definedBy: {
					_id: user._id,
					username: user.username,
				},
				...(priority && { priority }),
			},
		});
	}

	removeByRoomId(roomId: string): Promise<DeleteResult> {
		return this.deleteMany({ rid: roomId });
	}
}

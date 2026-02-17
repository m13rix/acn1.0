import {
	AbsoluteFill,
	interpolate,
	useCurrentFrame,
	useVideoConfig,
	Img,
	staticFile,
	Audio,
	Easing,
} from 'remotion';
import React from 'react';

export const Shot16: React.FC = () => {
	const frame = useCurrentFrame();
	const {durationInFrames} = useVideoConfig();

	// Timeline scaling: 5.74s total
	// Segments: 0-6s (Empty), 6-12s (Children) scaled
	const splitFrame = Math.round((6 / 12) * durationInFrames);

	// Children Silhouette Appearance
	const childrenOpacity = interpolate(
		frame,
		[splitFrame, splitFrame + 15],
		[0, 1],
		{extrapolateLeft: 'clamp', extrapolateRight: 'clamp'}
	);

	// Glass Partition Effect (Reflections/Gloss)
	const glassGloss = interpolate(
		frame,
		[splitFrame, durationInFrames],
		[0.2, 0.4],
		{easing: Easing.out(Easing.quad)}
	);

	return (
		<AbsoluteFill style={{backgroundColor: 'black'}}>
			{/* Segment 1: Courtroom */}
			<AbsoluteFill>
				<Img
					src={staticFile('courtroom_empty.png')}
					style={{
						width: '100%',
						height: '100%',
						objectFit: 'cover',
					}}
				/>
			</AbsoluteFill>

			{/* Segment 2: Children Protection Metaphor */}
			<AbsoluteFill style={{opacity: childrenOpacity}}>
				<Img
					src={staticFile('children_court_protection.png')}
					style={{
						width: '100%',
						height: '100%',
						objectFit: 'cover',
					}}
				/>
				{/* Glass Partition Overlay */}
				<AbsoluteFill
					style={{
						background: 'linear-gradient(135deg, rgba(255,255,255,0.1) 0%, transparent 50%, rgba(255,255,255,0.1) 100%)',
						opacity: glassGloss,
						borderLeft: '2px solid rgba(255,255,255,0.2)',
						backdropFilter: 'blur(1px)',
					}}
				/>
			</AbsoluteFill>

			{/* Overlay Text */}
			{frame >= splitFrame && (
				<AbsoluteFill className="justify-center items-center">
					<div 
						className="bg-blue-900/80 px-8 py-4 rounded-lg border-2 border-white/50 shadow-2xl"
						style={{
							opacity: interpolate(frame, [splitFrame + 10, splitFrame + 25], [0, 1]),
							transform: `translateY(${interpolate(frame, [splitFrame + 10, splitFrame + 25], [20, 0], {extrapolateRight: 'clamp'})}px)`
						}}
					>
						<h2 
							className="text-white text-5xl font-bold text-center"
							style={{fontFamily: 'Inter, sans-serif'}}
						>
							несовершеннолетние дети = Суд
						</h2>
					</div>
				</AbsoluteFill>
			)}

			<Audio src={staticFile('shot16_voice.mp3')} />
		</AbsoluteFill>
	);
};
